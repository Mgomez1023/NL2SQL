import duckdb
import json
from pathlib import Path
from typing import Any, Dict, Optional

DB_PATH = Path("data/app.duckdb")
TABLE_NAME = "ds_active"
SAMPLE_CSV = Path("data/sample.csv")
ACTIVE_CSV = Path("data/uploads/active.csv")
ACTIVE_META = Path("data/uploads/active_meta.json")

def get_conn() -> duckdb.DuckDBPyConnection:
    """
    Opens (or creates) the DuckDB database file.
    DuckDB is embedded, so this is just a file on disk.
    """
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
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
