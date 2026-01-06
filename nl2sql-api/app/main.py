from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from app.db import ensure_sample_loaded, get_conn, TABLE_NAME
from app.llm import generate_sql, repair_sql
from uuid import uuid4
from datetime import datetime, timezone
from typing import Any, Dict, Optional
import re

DEFAULT_LIMIT = 100
app = FastAPI(title="NL2SQL API", version="0.1.0")
QUERY_STORE: Dict[str, Dict[str, Any]] = {}

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

#HEALTH
@app.get("/health")
def health():
    return {"ok": True}

#ROOT
@app.get("/")
def root():
    return {"message": "Welcome to the NL2SQL API! This is the root() function   "}

class EchoRequest(BaseModel):
    message: str

#POST
@app.post("/echo") 
def echo(req:  EchoRequest):
    return {
        "You Sent: ":  req.message
    }

#STARTUP
@app.on_event("startup")
def startup():
    """
    Ensures that the sample data is loaded into the database on startup.
    """
    ensure_sample_loaded()

#SCHEMA - DB CONNECTION
@app.get("/schema")
def schema():
    con = get_conn()
    try:
        #DESCRIBE returns: column_name, column_type, null, key, default, extra(varies)
        rows = con.execute(f"DESCRIBE {TABLE_NAME}").fetchall()
    finally:
        con.close()
    
    #Normalize into a clean JSON structure
    columns = []
    for r in rows:
        #DuckDB typically has column_name, column_type, null, key, default
        columns.append(
            {
                "name": r[0],
                "type": r[1],
            }
        )

        return {
            "table": TABLE_NAME,
            "columns": columns
        }

#SQL PREVIEW
@app.get("/preview")
def preview():
    con = get_conn()
    try:
        cols = [d[0] for d in con.execute(f"SELECT * FROM {TABLE_NAME} LIMIT 10").description]
        rows = con.execute(f"SELECT * FROM {TABLE_NAME} LIMIT 10").fetchall()
    finally:
        con.close()
    
    return {"table": TABLE_NAME, "columns":  cols, "rows": rows}

class SQLRequest(BaseModel):
    sql: str

#POST SQL - ASK QUESTION
@app.post("/sql")
def run_sql(req: SQLRequest):
        sql = req.sql

        #SELECT only
        if not is_safe_select(req .sql):
            raise HTTPException(status_code=400, detail="Only single SELEct queries are allowed.")
        
        #Proper Table
        if not references_only_allowed_table(sql, TABLE_NAME):
            raise HTTPException(status_code=400, detail=f"Query must reference only {TABLE_NAME}.")
        
        #Enforce Limit
        sql = ensure_limit(sql)

        con = get_conn()
        try:
            #execute once to get column names
            try:
                cur = con.execute(req.sql)
            except Exception as e:
                raise HTTPException(status_code=400, detail=f"SQL error: {e}")
            
            cols = [d[0] for d in cur.description] if cur.description else []
            rows = cur.fetchall() if cols else []
        finally:
            con.close()
        
        return {"sql": sql, "columns": cols, "rows": rows}

#QUERY REQUEST
class QueryRequest(BaseModel):
    question: str

@app.post("/query")
def query(req: QueryRequest):
    query_id = f"q_{uuid4().hex}"
    schema_text = schema_as_text()

    llm = generate_sql(schema_text=schema_text, question=req.question)

    sql = llm.get("sql")
    if not isinstance(sql, str) or not sql.strip():
        raise HTTPException(status_code=400, detail="Model did not return a valid 'sql' string.")

    # Apply your guardrails
    if not is_safe_select(sql):
        return {
            "ok": False,
            "query_id": query_id,
            "question": req.question,
            "sql": sql,
            "retryable": True,
            "error": {"type": "unsafe_sql", "message": "Model produced non-SELECT SQL; rejected."},
            "timestamp": now_iso(),
        }
    
    if not references_only_allowed_table(sql, TABLE_NAME):
        return {
            "ok": False,
            "query_id": query_id,
            "question": req.question,
            "sql": sql,
            "retryable": True,
            "error": {"type": "wrong_table", "message": f"Query must reference only {TABLE_NAME}."},
            "timestamp": now_iso(),
        }
    sql = ensure_limit(sql)

    # Execute
    con = get_conn()
    try:
        try:
            cur = con.execute(sql)
            cols = [d[0] for d in cur.description] if cur.description else []
            rows = cur.fetchall() if cols else []
        except Exception as e:
            # Store enough to retry
            err_msg = str(e)
            QUERY_STORE[query_id] = {
                "question": req.question,
                "sql": sql,
                "error": err_msg,
                "schema": schema_text,
            }
            return {
                "ok": False,
                "query_id": query_id,
                "question": req.question,
                "sql": sql,
                "retryable": True,
                "error": {"type": "sql_execution_error", "message": err_msg},
                "timestamp": now_iso(),
            }
    finally:
        con.close()

    return {
        "ok": True,
        "query_id": query_id,
        "question": req.question,
        "sql": sql,
        "columns": cols,
        "rows": rows,
        "meta": {
            "assumptions": llm.get("assumptions"),
            "confidence": llm.get("confidence"),
        },
        "timestamp": now_iso(),
    }

#RETRY REQUEST
class RetryRequest(BaseModel):
    query_id: str

@app.post("/query/retry")
def retry(req: RetryRequest):
    saved = QUERY_STORE.get(req.query_id)
    if not saved:
        raise HTTPException(status_code=404, detail="Unknown query_id (nothing to retry).")

    schema_text = saved["schema"]
    question = saved["question"]
    last_sql = saved["sql"]
    error_message = saved["error"]

    llm = repair_sql(
        schema_text=schema_text,
        question=question,
        last_sql=last_sql,
        error_message=error_message,
    )

    sql = llm.get("sql")
    if not isinstance(sql, str) or not sql.strip():
        raise HTTPException(status_code=400, detail="Repair model did not return valid SQL.")

    # Guardrails again
    if not is_safe_select(sql):
        raise HTTPException(status_code=400, detail="Repaired SQL was not a safe SELECT.")

    if not references_only_allowed_table(sql, TABLE_NAME):
        raise HTTPException(status_code=400, detail=f"Repaired SQL must reference only {TABLE_NAME}.")

    sql = ensure_limit(sql)

    con = get_conn()
    try:
        try:
            cur = con.execute(sql)
            cols = [d[0] for d in cur.description] if cur.description else []
            rows = cur.fetchall() if cols else []
        except Exception as e:
            # Update store with new attempt for another retry
            saved["sql"] = sql
            saved["error"] = str(e)
            raise HTTPException(status_code=400, detail=f"SQL error after retry: {e}")
    finally:
        con.close()

    # Optionally remove from store after success
    QUERY_STORE.pop(req.query_id, None)

    return {
        "ok": True,
        "query_id": req.query_id,
        "question": question,
        "sql": sql,
        "columns": cols,
        "rows": rows,
        "meta": {"confidence": llm.get("confidence")},
        "timestamp": now_iso(),
    }


#HELPER FUNCTIONS

#Build Schema from text helper function
def schema_as_text() -> str:
    con = get_conn()
    try:
        rows = con.execute(f"DESCRIBE {TABLE_NAME}").fetchall()
    finally:
        con.close()
    
    lines = [f"Table: {TABLE_NAME}"]
    for r in rows:
        lines.append(f"- {r[0]} ({r[1]})")
    
    return "\n".join(lines)

#make sure its a SELECT query
def is_safe_select(sql: str) -> bool:
    s = sql.strip().lower()

    #Make sure it starts with SELECT
    if not s.startswith("select"):
        return False
    
    #Basic blocklist (Will be improved later)
    blocked = [
        "insert", "update", "delete", "drop", "alter", "create",
        "attach", "copy", "pragma", "install", "load", "export"
    ]

    return not any(word in s for word in blocked)

#make sure its a usable table
def references_only_allowed_table(sql: str, allowed_table: str) -> bool:
    """
    Very simple check: reject queries that mention other obvious table sources.
    For MVP we enforce that the SQL contains the allowed table name.
    We'll improve later with an actual SQL parser.
    """
    lowerCaseRequest = sql.lower()
    return allowed_table.lower() in lowerCaseRequest

def ensure_limit(sql: str, default_limit: int = DEFAULT_LIMIT) -> str:
    """
    If the SQL doesn't contain LIMIT, add one at the end.
    This is intentionally simple for MVP.
    """
    strippedRequest = sql.strip().rstrip(";")
    if re.search(r"\blimit\b", strippedRequest, flags=re.IGNORECASE):
        return strippedRequest + ";"
    return f"{strippedRequest} LIMIT {default_limit};"

#Get ISO time
def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()
