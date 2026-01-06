import { useMemo, useState, useEffect, useRef } from "react";
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

type ActiveDialog = "none" | "schema" | "about";

const API_BASE = "http://127.0.0.1:8000";

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

export default function App() {
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [resp, setResp] = useState<QueryResponse | null>(null);
  const [networkError, setNetworkError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [dialog, setDialog] = useState<ActiveDialog>("none");

//DRAGGING FUNCTION
  const [aboutPos, setAboutPos] = useState<{ x: number; y: number } | null>(null);
  const dragRef = useRef<{
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    dragging: boolean;
  }>({ startX: 0, startY: 0, originX: 0, originY: 0, dragging: false });

  // Set initial position (center) when opening
  useEffect(() => {
    if (dialog === "about" && aboutPos === null) {
      const w = 420; // approximate width; window will still render fine
      const h = 220; // approximate height
      const x = Math.max(16, Math.round(window.innerWidth / 2 - w / 2));
      const y = Math.max(16, Math.round(window.innerHeight / 2 - h / 2));
      setAboutPos({ x, y });
    }
    if (dialog !== "about") {
      setAboutPos(null); // reset so it centers next open
    }
  }, [dialog, aboutPos]);

  function clamp(n: number, min: number, max: number) {
    return Math.min(Math.max(n, min), max);
  }

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
    const approxW = 520; // keep conservative if you don’t measure
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

  return (
    <>
    <div style={{ maxWidth: 700, margin: "0 auto" ,}}>
        <div className="window" style={{ width: "100%" }}>
          <div className="title-bar">
            <div className="title-bar-text">NL→SQL Explorer</div>
            <div className="title-bar-controls">
              <button aria-label="Minimize" />
              <button aria-label="Maximize" />
              <button aria-label="Close" />
            </div>
          </div>

          <div className="menu-bar">
            <a href="#" onClick={(e) => { e.preventDefault(); setResp(null); setNetworkError(null); }}>
              File
            </a>
            <a href="#" onClick={(e) => { e.preventDefault(); setDialog("schema"); }}>
              Dataset
            </a>
            <a href="#" onClick={(e) => { e.preventDefault(); setDialog("about"); }}>
              About
            </a>
          </div>

          <div className="window-body" style={{ padding: 12 }}>
            <div style={{ maxWidth: 900, margin: "40px auto", padding: 16 }}>
                  <h1 style={{ marginBottom: 6 }}>Natural Language→SQL Explorer</h1>
                  <div style={{ opacity: 0.8, marginBottom: 16 , textAlign: "center",}}>
                    Vite UI → FastAPI → OpenAI → DuckDB
                  </div>

                  <div style={{ display: "flex", gap: 10, alignItems: "center", }}>
                    <input
                      value={question}
                      onChange={(e) => setQuestion(e.target.value)}
                      placeholder='e.g. "Show me the top 10 pitch types by average velocity"'
                      style={{
                        flex: 1,
                        padding: 16,
                        fontSize: "14px",
                        borderRadius: 10,
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
                            <button onClick={() => retry(resp.query_id)} disabled={loading}>
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
                          <div style={{ overflowX: "auto", border: "1px solid #ddd", borderRadius: 10 }}>
                            <table style={{ width: "100%", borderCollapse: "collapse", color: "black", border: "2px grey solid" }}>
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
                                          borderBottom: "1px solid #eee",
                                          borderRight: "1px solid #ddd",
                                          whiteSpace: "nowrap",
                                          background: "#c4c4c4ff",
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
              <p style={{ marginTop: 0 }}>
                <b>NL→SQL Explorer</b>
              </p>
              <p>Natural language → safe SQL → DuckDB execution with AI-assisted retry.</p>
              <div style={{ textAlign: "right", marginTop: 12 }}>
                <button style={{color: "white"}}onClick={() => setDialog("none")}>OK</button>
              </div>
            </div>
          </div>
        </div>
      )}


    </>
 )} 

