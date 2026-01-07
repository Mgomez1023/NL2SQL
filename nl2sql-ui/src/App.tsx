import { useMemo, useState, useEffect, useRef, useCallback } from "react";
import { format } from "sql-formatter";

type QueryOk = {
  ok: true;
  question: string;
  sql: string;
  columns: string[];
  rows: Array<Array<string | number | null>>;
  meta?: any;
};

type QueryErr = {
  ok: false;
  question?: string;
  sql?: string;
  error?: { type?: string; message: string };
  retryable?: boolean;
  detail?: string; // FastAPI HTTPException often returns {detail: "..."}
};

type QueryResponse = QueryOk | QueryErr;

type SchemaColumn = {
  name: string;
  type: string;
};

type SchemaResponse = {
  table: string;
  row_count: number;
  source: string;
  filename: string;
  columns: SchemaColumn[];
};

type ActiveDialog = "none" | "schema" | "about" | "upload";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:8000";

type ExamplePrompt = {
  label: string;
  prompt: string;
};

function clamp(n: number, min: number, max: number) {
  return Math.min(Math.max(n, min), max);
}

function formatSQL(sql: string) {
  try {
    return format(sql, {
      language: "sql",
      tabWidth: 2,
      keywordCase: "upper",
    });
  } catch {
    return sql;
  }
}

function buildExamplePrompts(schema: SchemaResponse | null): ExamplePrompt[] {
  const genericBase = [
    "Show me 10 rows",
    "How many rows are in this dataset?",
    "List the columns available",
  ];

  if (!schema || !schema.columns || schema.columns.length === 0) {
    return genericBase.map((prompt) => ({ label: prompt, prompt }));
  }

  const cols = schema.columns.map((col) => ({
    name: col.name,
    lower: col.name.toLowerCase(),
    type: col.type.toLowerCase(),
  }));

  const hasPlayerName = cols.some((c) => c.lower === "player_name");
  const hasPitches = cols.some((c) => c.lower === "pitches");

  if (hasPlayerName && hasPitches) {
    const baseball = [
      "Top 10 pitchers by pitches thrown",
      "Average velocity by player_name (top 10 by pitches)",
      "Highest whiff rate (whiffs / swings) among pitchers with swings > 2000",
      "Compare wOBA vs xwOBA for the top 10 by pitches",
      "Show pitchers with the largest difference between BA and xBA",
      "Average launch_angle against each player_name (top 10 by pitches)",
    ];
    return baseball.map((prompt) => ({ label: prompt, prompt }));
  }

  const numericTypes = ["double", "float", "real", "integer", "bigint", "decimal"];
  const categoricalTypes = ["varchar", "text", "string"];

  const numericCols = cols.filter((c) => numericTypes.some((t) => c.type.includes(t)));
  const categoricalCols = cols.filter((c) => categoricalTypes.some((t) => c.type.includes(t)));

  const isIdLike = (name: string) => name.includes("id") || name.includes("uuid") || name.includes("key");
  const bestNumeric =
    numericCols.find((c) => !isIdLike(c.lower))?.name ?? numericCols[0]?.name ?? null;

  const preferredCat = ["name", "type", "category", "team"];
  const bestCategorical =
    categoricalCols.find((c) => preferredCat.some((hint) => c.lower.includes(hint)))?.name ??
    categoricalCols[0]?.name ??
    null;

  const prompts: ExamplePrompt[] = [];
  for (const prompt of genericBase) {
    prompts.push({ label: prompt, prompt });
  }

  if (bestNumeric) {
    const prompt = `Top 10 rows by ${bestNumeric}`;
    prompts.push({ label: prompt, prompt });
  }

  if (bestNumeric && bestCategorical) {
    const prompt = `Average ${bestNumeric} by ${bestCategorical}`;
    prompts.push({ label: prompt, prompt });
  }

  return prompts;
}

export default function App() {
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [resp, setResp] = useState<QueryResponse | null>(null);
  const [networkError, setNetworkError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [dialog, setDialog] = useState<ActiveDialog>("none");
  const [schemaData, setSchemaData] = useState<SchemaResponse | null>(null);
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [datasetMenuOpen, setDatasetMenuOpen] = useState(false);
  const [datasetBusy, setDatasetBusy] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const datasetMenuRef = useRef<HTMLDivElement | null>(null);
  const questionInputRef = useRef<HTMLInputElement | null>(null);

//DRAGGING FUNCTION
  const [mainPos, setMainPos] = useState<{ x: number; y: number } | null>(null);
  const mainDragRef = useRef<{
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    dragging: boolean;
  }>({ startX: 0, startY: 0, originX: 0, originY: 0, dragging: false });

  const [aboutPos, setAboutPos] = useState<{ x: number; y: number } | null>(null);
  const dragRef = useRef<{
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    dragging: boolean;
  }>({ startX: 0, startY: 0, originX: 0, originY: 0, dragging: false });

  const [schemaPos, setSchemaPos] = useState<{ x: number; y: number } | null>(null);
  const schemaDragRef = useRef<{
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    dragging: boolean;
  }>({ startX: 0, startY: 0, originX: 0, originY: 0, dragging: false });

  const [uploadPos, setUploadPos] = useState<{ x: number; y: number } | null>(null);
  const uploadDragRef = useRef<{
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    dragging: boolean;
  }>({ startX: 0, startY: 0, originX: 0, originY: 0, dragging: false });

  useEffect(() => {
    if (mainPos === null) {
      const w = 700;
      const h = 620;
      const x = Math.max(16, Math.round(window.innerWidth / 2 - w / 2));
      const y = Math.max(16, Math.round(window.innerHeight / 2 - h / 2));
      setMainPos({ x, y });
    }
  }, [mainPos]);

  function onMainTitlePointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return;

    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);

    const pos = mainPos ?? { x: 0, y: 0 };

    mainDragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      originX: pos.x,
      originY: pos.y,
      dragging: true,
    };
  }

  const onMainPointerMove = useCallback((e: PointerEvent) => {
    if (!mainDragRef.current.dragging) return;

    const dx = e.clientX - mainDragRef.current.startX;
    const dy = e.clientY - mainDragRef.current.startY;

    const margin = 8;
    const approxW = 740;
    const approxH = 700;

    const x = clamp(mainDragRef.current.originX + dx, margin, window.innerWidth - approxW - margin);
    const y = clamp(mainDragRef.current.originY + dy, margin, window.innerHeight - approxH - margin);

    setMainPos({ x, y });
  }, []);

  function stopMainDragging() {
    mainDragRef.current.dragging = false;
  }

  useEffect(() => {
    window.addEventListener("pointermove", onMainPointerMove);
    window.addEventListener("pointerup", stopMainDragging);
    window.addEventListener("pointercancel", stopMainDragging);

    return () => {
      window.removeEventListener("pointermove", onMainPointerMove);
      window.removeEventListener("pointerup", stopMainDragging);
      window.removeEventListener("pointercancel", stopMainDragging);
    };
  }, [onMainPointerMove]);

  // Set initial position (center) when opening
  useEffect(() => {
    if (dialog === "about" && aboutPos === null) {
      const w = 420; // approximate width; window will still render fine
      const h = 220; // approximate height
      const x = Math.max(16, Math.round(window.innerWidth / 2 - w / 2));
      const y = Math.max(16, Math.round(window.innerHeight / 2 - h / 2));
      setAboutPos({ x, y });
    }
    if (dialog === "schema" && schemaPos === null) {
      const w = 520;
      const h = 360;
      const x = Math.max(16, Math.round(window.innerWidth / 2 - w / 2));
      const y = Math.max(16, Math.round(window.innerHeight / 2 - h / 2));
      setSchemaPos({ x, y });
    }
    if (dialog === "upload" && uploadPos === null) {
      const w = 460;
      const h = 240;
      const x = Math.max(16, Math.round(window.innerWidth / 2 - w / 2));
      const y = Math.max(16, Math.round(window.innerHeight / 2 - h / 2));
      setUploadPos({ x, y });
    }
    if (dialog !== "about") setAboutPos(null); // reset so it centers next open
    if (dialog !== "schema") setSchemaPos(null);
    if (dialog !== "upload") setUploadPos(null);
  }, [dialog, aboutPos, schemaPos, uploadPos]);

  function onAboutTitlePointerDown(e: React.PointerEvent) {
    // only left-click / primary touch
    if (e.button !== 0) return;

    // Capture pointer so dragging continues even if cursor leaves title bar
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);

    const pos = aboutPos ?? { x: 0, y: 0 };

    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      originX: pos.x,
      originY: pos.y,
      dragging: true,
    };
  }

  function onPointerMove(e: PointerEvent) {
    if (!dragRef.current.dragging) return;

    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;

    // Optional: keep window inside viewport with a small margin
    const margin = 8;
    const approxW = 520; // keep conservative if you do not measure
    const approxH = 260;

    const x = clamp(dragRef.current.originX + dx, margin, window.innerWidth - approxW - margin);
    const y = clamp(dragRef.current.originY + dy, margin, window.innerHeight - approxH - margin);

    setAboutPos({ x, y });
  }

  function stopDragging() {
    dragRef.current.dragging = false;
  }

  // Attach global listeners while About is open
  useEffect(() => {
    if (dialog !== "about") return;

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", stopDragging);
    window.addEventListener("pointercancel", stopDragging);

    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", stopDragging);
      window.removeEventListener("pointercancel", stopDragging);
    };
  }, [dialog, aboutPos]);

  function onSchemaTitlePointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);

    const pos = schemaPos ?? { x: 0, y: 0 };
    schemaDragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      originX: pos.x,
      originY: pos.y,
      dragging: true,
    };
  }

  function onSchemaPointerMove(e: PointerEvent) {
    if (!schemaDragRef.current.dragging) return;

    const dx = e.clientX - schemaDragRef.current.startX;
    const dy = e.clientY - schemaDragRef.current.startY;

    const margin = 8;
    const approxW = 560;
    const approxH = 420;

    const x = clamp(schemaDragRef.current.originX + dx, margin, window.innerWidth - approxW - margin);
    const y = clamp(schemaDragRef.current.originY + dy, margin, window.innerHeight - approxH - margin);

    setSchemaPos({ x, y });
  }

  function stopSchemaDragging() {
    schemaDragRef.current.dragging = false;
  }

  useEffect(() => {
    if (dialog !== "schema") return;

    window.addEventListener("pointermove", onSchemaPointerMove);
    window.addEventListener("pointerup", stopSchemaDragging);
    window.addEventListener("pointercancel", stopSchemaDragging);

    return () => {
      window.removeEventListener("pointermove", onSchemaPointerMove);
      window.removeEventListener("pointerup", stopSchemaDragging);
      window.removeEventListener("pointercancel", stopSchemaDragging);
    };
  }, [dialog, schemaPos]);

  function onUploadTitlePointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);

    const pos = uploadPos ?? { x: 0, y: 0 };
    uploadDragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      originX: pos.x,
      originY: pos.y,
      dragging: true,
    };
  }

  function onUploadPointerMove(e: PointerEvent) {
    if (!uploadDragRef.current.dragging) return;

    const dx = e.clientX - uploadDragRef.current.startX;
    const dy = e.clientY - uploadDragRef.current.startY;

    const margin = 8;
    const approxW = 520;
    const approxH = 280;

    const x = clamp(uploadDragRef.current.originX + dx, margin, window.innerWidth - approxW - margin);
    const y = clamp(uploadDragRef.current.originY + dy, margin, window.innerHeight - approxH - margin);

    setUploadPos({ x, y });
  }

  function stopUploadDragging() {
    uploadDragRef.current.dragging = false;
  }

  useEffect(() => {
    if (dialog !== "upload") return;

    window.addEventListener("pointermove", onUploadPointerMove);
    window.addEventListener("pointerup", stopUploadDragging);
    window.addEventListener("pointercancel", stopUploadDragging);

    return () => {
      window.removeEventListener("pointermove", onUploadPointerMove);
      window.removeEventListener("pointerup", stopUploadDragging);
      window.removeEventListener("pointercancel", stopUploadDragging);
    };
  }, [dialog, uploadPos]);

  useEffect(() => {
    if (!datasetMenuOpen) return;

    function onPointerDown(e: PointerEvent) {
      const target = e.target as Node;
      if (datasetMenuRef.current && !datasetMenuRef.current.contains(target)) {
        setDatasetMenuOpen(false);
      }
    }

    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [datasetMenuOpen]);

  useEffect(() => {
    refreshSchema();
  }, []);

  async function refreshSchema() {
    setSchemaError(null);
    try {
      const r = await fetch(`${API_BASE}/schema`);
      const data = (await r.json().catch(() => ({}))) as any;
      if (!r.ok) {
        setSchemaError(data?.detail ?? `HTTP ${r.status}`);
        return;
      }
      setSchemaData(data as SchemaResponse);
    } catch (e: any) {
      setSchemaError(e?.message ?? "Network error");
    }
  }

  async function openSchemaDialog() {
    setDialog("schema");
    await refreshSchema();
  }

  async function useDemoDataset() {
    setDatasetBusy(true);
    setSchemaError(null);
    setNetworkError(null);
    setDatasetMenuOpen(false);
    try {
      const r = await fetch(`${API_BASE}/dataset/use-demo`, { method: "POST" });
      const data = (await r.json().catch(() => ({}))) as any;
      if (!r.ok) {
        setSchemaError(data?.detail ?? `HTTP ${r.status}`);
        return;
      }
      setSchemaData(data as SchemaResponse);
      setResp(null);
    } catch (e: any) {
      setSchemaError(e?.message ?? "Network error");
    } finally {
      setDatasetBusy(false);
    }
  }

  async function uploadDataset() {
    if (!uploadFile) {
      setSchemaError("Choose a CSV file first.");
      return;
    }

    setDatasetBusy(true);
    setSchemaError(null);
    setNetworkError(null);
    try {
      const form = new FormData();
      form.append("file", uploadFile);
      const r = await fetch(`${API_BASE}/dataset/upload`, { method: "POST", body: form });
      const data = (await r.json().catch(() => ({}))) as any;
      if (!r.ok) {
        setSchemaError(data?.detail ?? `HTTP ${r.status}`);
        return;
      }
      setSchemaData(data as SchemaResponse);
      setResp(null);
      setDialog("none");
      setUploadFile(null);
    } catch (e: any) {
      setSchemaError(e?.message ?? "Network error");
    } finally {
      setDatasetBusy(false);
    }
  }


  const hasTable = useMemo(() => {
    return resp && resp.ok === true && resp.columns?.length > 0;
  }, [resp]);

  async function ask() {
    const q = question.trim();
    if (!q) return;

    setLoading(true);
    setNetworkError(null);
    setResp(null);

    try {
      const r = await fetch(`${API_BASE}/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q }),
      });

      // Even if !ok, FastAPI often returns JSON {detail: "..."}.
      const data = (await r.json().catch(() => ({}))) as any;

      if (!r.ok) {
        setResp({
          ok: false,
          question: q,
          detail: data?.detail ?? `HTTP ${r.status}`,
        });
        return;
      }

      setResp(data as QueryResponse);
    } catch (e: any) {
      setNetworkError(e?.message ?? "Network error");
    } finally {
      setLoading(false);
    }
  }


async function retry(queryId: string) {
  setLoading(true);
  setNetworkError(null);

  try {
    const r = await fetch(`${API_BASE}/query/retry`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query_id: queryId }),
    });

    const data = (await r.json().catch(() => ({}))) as any;

    if (!r.ok) {
      setResp({
        ok: false,
        detail: data?.detail ?? `HTTP ${r.status}`,
      } as any);
      return;
    }

    setResp(data);
  } catch (e: any) {
    setNetworkError(e?.message ?? "Network error");
  } finally {
    setLoading(false);
  }
}

async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for older browsers / permissions
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  }
}

  const datasetLabel = useMemo(() => {
    if (!schemaData) return "Dataset: Loading...";
    const sourceLabel = schemaData.source === "upload" ? "Uploaded" : "Demo";
    const filename = schemaData.filename || schemaData.table;
    const rowCount = typeof schemaData.row_count === "number" ? `${schemaData.row_count} rows` : "rows unknown";
    return `Dataset: ${sourceLabel} (${filename}, ${rowCount})`;
  }, [schemaData]);

  const examplePrompts = useMemo(() => {
    return buildExamplePrompts(schemaData);
  }, [schemaData]);

  return (
    <>
    <div
        className="main-window"
        style={{
          left: mainPos?.x ?? 0,
          top: mainPos?.y ?? 0,
          width: "min(700px, calc(100vw - 48px))",
        }}
      >
        <div className="window" style={{ width: "100%" }}>
          <div className="title-bar draggable" onPointerDown={onMainTitlePointerDown}>
            <div className="title-bar-text">NL→SQL Explorer</div>
            <div className="title-bar-controls">
              <button aria-label="Minimize" />
              <button aria-label="Maximize" />
              <button aria-label="Close" />
            </div>
          </div>

          <div className="menu-bar win95-menu">
            <a href="#" onClick={(e) => { e.preventDefault(); setResp(null); setNetworkError(null); }}>
              Reset
            </a>
            <div className="menu-item" ref={datasetMenuRef}>
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  setDatasetMenuOpen((open) => !open);
                }}
              >
                Dataset
              </a>
              {datasetMenuOpen && (
                <div className="menu-dropdown">
                  <button type="button" disabled={datasetBusy} onClick={useDemoDataset}>
                    Use Demo Dataset
                  </button>
                  <button
                    type="button"
                    disabled={datasetBusy}
                    onClick={() => {
                      setSchemaError(null);
                      setUploadFile(null);
                      setDialog("upload");
                      setDatasetMenuOpen(false);
                    }}
                  >
                    Upload CSV...
                  </button>
                  <button
                    type="button"
                    disabled={datasetBusy}
                    onClick={() => {
                      setDatasetMenuOpen(false);
                      openSchemaDialog();
                    }}
                  >
                    Schema
                  </button>
                </div>
              )}
            </div>
            <a href="#" onClick={(e) => { e.preventDefault(); setDialog("about"); }}>
              About
            </a>
          </div>

          <div className="window-body" style={{ padding: 12 }}>
            <div style={{ maxWidth: 900, margin: "0px auto 40px auto", padding: 16 }}>
                  <h1 style={{ marginBottom: 6 }}>Natural Language→SQL Explorer</h1>
                  <div style={{ opacity: 0.8, marginBottom: 16 , textAlign: "center",}}>
                    Vite UI → FastAPI → OpenAI → DuckDB
                  </div>
                  <div style={{ fontSize: "12px", opacity: 0.85, marginBottom: 16, textAlign: "center" }}>
                    {datasetLabel}
                  </div>

                  <div style={{ display: "flex", gap: 10, alignItems: "center", }}>
                    <input
                      ref={questionInputRef}
                      value={question}
                      onChange={(e) => setQuestion(e.target.value)}
                      placeholder='e.g. "Show me the top 10 pitch types by average velocity"'
                      style={{
                        flex: 1,
                        padding: 14,
                        fontSize: "18px",
                        fontWeight: 500,
                        borderRadius: 0,
                        border: "1px solid #ccc",
                        backgroundColor: "white",
                        color:"black",
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") ask();
                      }}
                    />
                    <button
                      onClick={ask}
                      disabled={loading || !question.trim()}
                      style={{
                        padding: "10px 14px",
                        background: "#555555ff",
                        borderRadius: 10,
                        border: "1px solid #333",
                        cursor: loading ? "not-allowed" : "pointer",
                        color: "white",
                        fontSize: "14px",
                        fontFamily: "monospace",
                      }}
                    >
                      {loading ? "Asking..." : "Ask"}
                    </button>
                  </div>

                  <div style={{ marginTop: 10 }}>
                    <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 6 }}>Examples:</div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      {examplePrompts.map((ex) => (
                        <button
                          key={ex.prompt}
                          type="button"
                          disabled={loading}
                          onClick={() => {
                            setQuestion(ex.prompt);
                            questionInputRef.current?.focus();
                          }}
                          style={{
                            padding: "4px 10px",
                            borderRadius: 0,
                            border: "1px solid #333",
                            background: "#d8d8d8",
                            color: "black",
                            fontSize: 12,
                            cursor: loading ? "not-allowed" : "pointer",
                          }}
                        >
                          {ex.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {networkError && (
                    <div style={{ marginTop: 16, color: "crimson" }}>
                      <b>Network error:</b> {networkError}
                      <div style={{ marginTop: 6, opacity: 0.85 }}>
                        If you see CORS issues in the browser console, confirm you added
                        CORSMiddleware to FastAPI and restarted uvicorn.
                      </div>
                    </div>
                  )}

                  {resp && resp.ok === false && (
                    <div
                      style={{
                        marginTop: 16,
                        padding: 12,
                        borderRadius: 10,
                        border: "1px solid #e0b4b4",
                        background: "#fff5f5",
                        color: "black",
                      }}
                    >
                      <div style={{ fontWeight: 700, marginBottom: 6 }}>Error</div>
                      <div>{resp.error?.message ?? resp.detail ?? "Unknown error"}</div>

                      {resp.sql && (
                        <>
                          <div style={{ marginTop: 10, fontWeight: 700 }}>SQL (attempted)</div>
                          <pre
                            style={{
                              marginTop: 6,
                              padding: 10,
                              background: "#f7f7f7",
                              overflowX: "hidden",
                              whiteSpace: "pre-wrap",
                              wordBreak: "break-word",
                              fontFamily: "monospace",
                          }}
                          >
                            {formatSQL(resp.sql)}
                          </pre>
                        </>
                      )}

                      <div className="window" style={{ marginTop: 12 }}>
                        <div className="title-bar">
                          <div className="title-bar-text">Error</div>
                          <div className="title-bar-controls">
                            <button aria-label="Close" />
                          </div>
                        </div>
                        <div className="window-body">
                          <p style={{ marginTop: 0 }}>{resp.error?.message ?? resp.detail ?? "Unknown error"}</p>
                          {resp.query_id && resp.retryable && (
                            <button style={{color: "white"}}onClick={() => retry(resp.query_id)} disabled={loading}>
                              {loading ? "Retrying..." : "Retry"}
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
            )}

                  {resp && resp.ok === true && (
                    <div style={{ marginTop: "15px", borderTop: "2px solid dark-grey" , }}>
                      <div style={{display: "flex", flexDirection: "row", justifyContent: "space-between", alignContent: "center", marginTop: "8px",
                      }}>  
                        <div style={{ fontWeight: 700, marginBottom: 6, }}>Generated SQL</div>
                          {resp?.ok === true && resp.sql && (
                              <button
                                onClick={async () => {
                                  const ok = await copyToClipboard(resp.sql);
                                  if (ok) {
                                    setCopied(true);
                                    setTimeout(() => setCopied(false), 1200);
                                  }
                                }}
                                style={{
                                  padding: "6px 14px",
                                  background: "#555555ff",
                                  borderRadius: 10,
                                  border: "1px solid #333",
                                  cursor: loading ? "not-allowed" : "pointer",
                                  color: "white",
                                }}
                              >
                                {copied ? "Copied" : "Copy SQL"}
                              </button>
                            )}
                      </div>

                      <pre
                        style={{
                              marginTop: 6,
                              padding: 10,
                              background: "#f7f7f7",
                              overflowX: "hidden",
                              whiteSpace: "pre-wrap",
                              wordBreak: "break-word",
                              fontFamily: "monospace",
                        }}
                      >
                        {formatSQL(resp.sql)}
                      </pre>

                      {hasTable ? (
                        <>
                          <div style={{ fontWeight: 700, marginTop: 14 }}>Results</div>
                          <div
                            style={{
                              width: 640,
                              maxWidth: "100%",
                              maxHeight: "30vh",
                              overflow: "auto",
                              border: "1px solid #ddd",
                              borderRadius: 10,
                            }}
                          >
                            <table style={{ width: "100%", borderCollapse: "collapse", color: "black", border: "2px grey solid",  borderTop: "2px solid dark-grey" }}>
                              <thead>
                                <tr>
                                  {resp.columns.map((c) => (
                                    <th
                                      key={c}
                                      style={{
                                        textAlign: "left",
                                        padding: 10,
                                        background: "#a8a8a8ff",
                                        fontWeight: 500,
                                      }}
                                    >
                                      {c}
                                    </th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {resp.rows.map((row, i) => (
                                  <tr key={i}>
                                    {row.map((cell, j) => (
                                      <td
                                        key={j}
                                        style={{
                                          padding: 10,
                                          borderBottom: "1px solid #a8a8a8ff",
                                          borderRight: "1px solid #a8a8a8ff",
                                          whiteSpace: "nowrap",
                                          background: "#f7f7f7",
                                          color: "black",
                                        }}
                                      >
                                        {cell === null ? "null" : String(cell)}
                                      </td>
                                    ))}
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </>
                      ) : (
                        <div style={{ marginTop: 12, opacity: 0.8 }}>
                          No table rows returned.
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* 
                
                <li>
                  <ul>Show me the top 10 pitch types by average velocity (PASS)</ul>
                  <ul>Show me average horizontal break by pitch type (FAIL)</ul>
                </li>
                */}

          </div>
        </div>
      </div>

      {dialog === "schema" && schemaPos && (
        <div className="modal-overlay" onClick={() => setDialog("none")}>
          <div
            className="window modal-window"
            onClick={(e) => e.stopPropagation()}
            style={{ left: schemaPos.x, top: schemaPos.y, width: 520 }}
          >
            <div className="title-bar draggable" onPointerDown={onSchemaTitlePointerDown}>
              <div className="title-bar-text">Schema</div>
              <div className="title-bar-controls">
                <button aria-label="Close" onClick={() => setDialog("none")} />
              </div>
            </div>
            <div className="window-body" style={{ maxHeight: "40vh", overflowY: "auto" }}>
              {schemaError && (
                <div style={{ color: "crimson", marginBottom: 8 }}>
                  <b>Error:</b> {schemaError}
                </div>
              )}
              {!schemaError && schemaData && (
                <>
                  <div><b>Table:</b> {schemaData.table}</div>
                  <div><b>Source:</b> {schemaData.source}</div>
                  <div><b>File:</b> {schemaData.filename}</div>
                  <div><b>Rows:</b> {schemaData.row_count}</div>
                  <div style={{ marginTop: 10, fontWeight: 700 }}>Columns</div>
                  <ul style={{ margin: "6px 0 0 18px" }}>
                    {schemaData.columns.map((col) => (
                      <li key={col.name}>
                        {col.name} ({col.type})
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {!schemaError && !schemaData && (
                <div>No schema loaded.</div>
              )}
              <div style={{ textAlign: "right", marginTop: 12 }}>
                <button style={{ color: "white", background: "#555555ff",}} onClick={() => setDialog("none")}>
                  OK
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {dialog === "upload" && uploadPos && (
        <div className="modal-overlay" onClick={() => setDialog("none")}>
          <div
            className="window modal-window"
            onClick={(e) => e.stopPropagation()}
            style={{ left: uploadPos.x, top: uploadPos.y }}
          >
            <div className="title-bar draggable" onPointerDown={onUploadTitlePointerDown}>
              <div className="title-bar-text">Upload CSV</div>
              <div className="title-bar-controls">
                <button aria-label="Close" onClick={() => setDialog("none")} />
              </div>
            </div>
            <div className="window-body">
              {schemaError && (
                <div style={{ color: "crimson", marginBottom: 8 }}>
                  <b>Error:</b> {schemaError}
                </div>
              )}
              <input
                type="file"
                accept=".csv,text/csv"
                onChange={(e) => setUploadFile(e.target.files?.[0] ?? null)}
              />
              <div style={{ textAlign: "right", marginTop: 12 }}>
                <button
                  onClick={uploadDataset}
                  disabled={datasetBusy || !uploadFile}
                  style={{ color: "white", marginRight: 8, background: "#555555ff", }}
                >
                  {datasetBusy ? "Uploading..." : "Upload"}
                </button>
                <button onClick={() => setDialog("none")} style={{ color: "white", background: "#555555ff",  }}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {dialog === "about" && aboutPos && (
        <div
          className="modal-overlay"
          onClick={() => setDialog("none")}
        >
          <div
            className="window modal-window"
            onClick={(e) => e.stopPropagation()}
            style={{ left: aboutPos.x, top: aboutPos.y }}
          >
            <div
              className="title-bar draggable"
              onPointerDown={onAboutTitlePointerDown}
            >
              <div className="title-bar-text">About</div>
              <div className="title-bar-controls">
                <button aria-label="Close" onClick={() => setDialog("none")} />
              </div>
            </div>

            <div className="window-body">
              <p style={{ marginTop: 0, fontSize: "14px" }}>
                <b>NL→SQL Explorer</b>
              </p>
              <p style={{marginLeft: "10px", fontSize: "14px" }}>NL2SQL explorer is a program written to turn natural language into 
                usable SQL queries that can be executed to return results.
              </p>

              <b style={{fontSize: "14px"}}>Data Flow:</b>

              <p style={{marginLeft: "10px", fontSize: "14px" }}>Natural language → OpenAI → safe SQL → DuckDB execution with AI-assisted retry.</p>
              <div style={{ textAlign: "right", marginTop: 12 }}>
                <button style={{color: "white", background: "#555555ff",}}onClick={() => setDialog("none")}>OK</button>
              </div>
            </div>
          </div>
        </div>
      )}


    </>
 )} 

