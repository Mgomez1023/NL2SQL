import os, json, re
from openai import OpenAI
from dotenv import load_dotenv

load_dotenv()

client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))

SYSTEM_PROMPT = """You generate SQL for DuckDB.
Return format:
- Return ONLY valid JSON (no markdown, no backticks, no code fences).
- Keys: sql (string), assumptions (string or list), confidence (number 0-1).
Rules:
- SQL must be a single SELECT statement.
- Query ONLY the table ds_main.
- Always include a LIMIT.
- Use only columns that exist in the schema.
"""

REPAIR_SYSTEM_PROMPT = """You repair DuckDB SQL.

Return ONLY valid JSON with keys: sql, confidence.
Rules:
- Single SELECT statement.
- Query ONLY the table ds_main.
- Always include a LIMIT.
- Use only columns that exist in the schema.
"""

def generate_sql(schema_text: str, question: str) -> dict:
    prompt = f"""Schema:
{schema_text}

Question:
{question}
"""

    # Keep output small and controlled
    resp = client.responses.create(
        model="gpt-4.1-mini",
        input=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": prompt},
        ],
        max_output_tokens=200,
    )

    # Responses API returns text; for MVP we parse JSON from the text
    raw = resp.output_text.strip()
    parsed = extract_json(raw)
    parsed["_raw"] = raw
    return parsed

def repair_sql(schema_text: str, question: str, last_sql: str, error_message: str) -> dict:
    prompt = f"""Schema:
{schema_text}

Question:
{question}

Last SQL:
{last_sql}

DuckDB error:
{error_message}

Fix the SQL to satisfy the question and schema.
"""
    resp = client.responses.create(
        model="gpt-4.1-mini",
        input=[
            {"role": "system", "content": REPAIR_SYSTEM_PROMPT},
            {"role": "user", "content": prompt},
        ],
        max_output_tokens=200,
    )
    raw = resp.output_text.strip()
    parsed = extract_json(raw)
    parsed["_raw"] = raw
    return parsed


def extract_json(text: str) -> dict:
    """
    Handles common model formatting:
    - ```json ... ```
    - ``` ... ```
    - leading/trailing text
    """
    t = text.strip()

    # Strip ```json ... ``` fences
    t = re.sub(r"^```json\s*", "", t, flags=re.IGNORECASE)
    t = re.sub(r"^```\s*", "", t)
    t = re.sub(r"\s*```$", "", t)

    # If still not pure JSON, try to extract the first {...} block
    if not t.startswith("{"):
        m = re.search(r"\{.*\}", t, flags=re.DOTALL)
        if not m:
            raise ValueError("No JSON object found in model output.")
        t = m.group(0)

    return json.loads(t)
