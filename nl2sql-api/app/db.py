import duckdb
from pathlib import Path

DB_PATH = Path("data/app.duckdb")
TABLE_NAME = "ds_main"
SAMPLE_CSV = Path("data/sample.csv")

def get_conn() -> duckdb.DuckDBPyConnection:
    """
    Opens (or creates) the DuckDB database file.
    DuckDB is embedded, so this is just a file on disk.
    """
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    return duckdb.connect(str(DB_PATH))

def ensure_sample_loaded() -> None:
    """
    Loads sample.csv into a DuckDB table (ds_main) if it doesn't exist yet.
    This is idempotent: safe to call on every startup.
    """
    if not SAMPLE_CSV.exists():
        raise FileNotFoundError(f"Missing {SAMPLE_CSV}. Create it first.")

    con = get_conn()
    try:
        # Check if table exists
        exists = con.execute(
            "SELECT COUNT(*) FROM information_schema.tables WHERE table_name = ?",
            [TABLE_NAME],
        ).fetchone()[0]

        if exists == 0:
            # read_csv_auto infers column types
            con.execute(
                f"""
                CREATE TABLE {TABLE_NAME} AS
                SELECT * FROM read_csv_auto(?, header=true);
                """,
                [str(SAMPLE_CSV)],
            )
    finally:
        con.close()
