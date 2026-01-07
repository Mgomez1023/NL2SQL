import duckdb
import json
from pathlib import Path
from typing import Any, Dict, Optional

from pathlib import Path
import os
import duckdb

# Base directory of the backend project (nl2sql-api/)
BASE_DIR = Path(__file__).resolve().parents[1]

# Detect serverless (Vercel/Lambda)
IS_SERVERLESS = (
    os.environ.get("VERCEL") == "1"
    or os.environ.get("AWS_LAMBDA_FUNCTION_NAME") is not None
)

# Writable runtime directory:
# - Local dev: nl2sql-api/data
# - Vercel: /tmp
RUNTIME_DIR = Path("/tmp") if IS_SERVERLESS else (BASE_DIR / "data")
RUNTIME_DIR.mkdir(parents=True, exist_ok=True)

# Read-only bundled demo CSV (must be committed in repo)
SAMPLE_CSV = BASE_DIR / "data" / "savant_data.csv"

# Writable paths (must NOT be under the repo on Vercel)
DB_PATH = RUNTIME_DIR / "app.duckdb"
ACTIVE_CSV = RUNTIME_DIR / "active.csv"
ACTIVE_META = RUNTIME_DIR / "active_meta.json"

TABLE_NAME = "ds_active"

def get_conn() -> duckdb.DuckDBPyConnection:
    """
    Opens (or creates) the DuckDB database file.
    Serverless note: On Vercel, only /tmp is writable.
    """
    return duckdb.connect(str(DB_PATH))


def _write_active_metadata(source: str, filename: str) -> None:
    ACTIVE_META.parent.mkdir(parents=True, exist_ok=True)
    ACTIVE_META.write_text(json.dumps({"source": source, "filename": filename}), encoding="utf-8")

def _read_active_metadata() -> Dict[str, Any]:
    if not ACTIVE_META.exists():
        return {}
    try:
        return json.loads(ACTIVE_META.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}

def load_csv_as_active(
    csv_path: Path,
    source: str,
    filename: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Replaces ds_active with the given CSV file and returns dataset metadata.
    """
    if not csv_path.exists():
        raise FileNotFoundError(f"Missing {csv_path}. Create it first.")

    con = get_conn()
    try:
        con.execute(f"DROP TABLE IF EXISTS {TABLE_NAME}")
        con.execute(
            f"""
            CREATE TABLE {TABLE_NAME} AS
            SELECT * FROM read_csv_auto(?, header=true);
            """,
            [str(csv_path)],
        )
        row_count = con.execute(f"SELECT COUNT(*) FROM {TABLE_NAME}").fetchone()[0]
        rows = con.execute(f"DESCRIBE {TABLE_NAME}").fetchall()
    finally:
        con.close()

    columns = [{"name": r[0], "type": r[1]} for r in rows]
    resolved_filename = filename or csv_path.name
    _write_active_metadata(source=source, filename=resolved_filename)

    return {
        "table": TABLE_NAME,
        "row_count": row_count,
        "source": source,
        "filename": resolved_filename,
        "columns": columns,
    }

def load_demo_as_active() -> Dict[str, Any]:
    """
    Forces ds_active to be replaced by the bundled demo dataset.
    """
    return load_csv_as_active(SAMPLE_CSV, source="demo", filename=SAMPLE_CSV.name)

def get_active_schema() -> Dict[str, Any]:
    con = get_conn()
    try:
        rows = con.execute(f"DESCRIBE {TABLE_NAME}").fetchall()
        row_count = con.execute(f"SELECT COUNT(*) FROM {TABLE_NAME}").fetchone()[0]
    finally:
        con.close()

    columns = [{"name": r[0], "type": r[1]} for r in rows]
    meta = _read_active_metadata()
    source = meta.get("source")
    filename = meta.get("filename")

    if not source:
        if ACTIVE_CSV.exists():
            source = "upload"
        else:
            source = "demo"

    if not filename:
        filename = ACTIVE_CSV.name if source == "upload" else SAMPLE_CSV.name

    return {
        "table": TABLE_NAME,
        "row_count": row_count,
        "source": source,
        "filename": filename,
        "columns": columns,
    }

def ensure_sample_loaded() -> None:
    """
    Loads sample.csv into a DuckDB table (ds_active) if it doesn't exist yet.
    This is idempotent: safe to call on every startup.
    """
    if not SAMPLE_CSV.exists():
        raise FileNotFoundError(f"Missing {SAMPLE_CSV}. Create it first.")

    con = get_conn()
    try:
        exists = con.execute(
            "SELECT COUNT(*) FROM information_schema.tables WHERE table_name = ?",
            [TABLE_NAME],
        ).fetchone()[0]
    finally:
        con.close()

    if exists == 0:
        if ACTIVE_CSV.exists():
            load_csv_as_active(ACTIVE_CSV, source="upload", filename=_read_active_metadata().get("filename"))
        else:
            load_demo_as_active()
