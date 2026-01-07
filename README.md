# NL2SQL (Vercel-ready, two deployments)

This repo is a monorepo with two apps:
- `nl2sql-api/`: FastAPI backend (DuckDB + CSV upload)
- `nl2sql-ui/`: Vite + React frontend

## Local development

Backend (FastAPI):
1) `cd nl2sql-api`
2) Create and activate a virtualenv
3) `pip install -r requirements.txt`
4) `uvicorn app.main:app --reload --port 8000`

Frontend (Vite):
1) `cd nl2sql-ui`
2) `npm install`
3) `npm run dev`

The UI defaults to `http://127.0.0.1:8000` if `VITE_API_BASE_URL` is not set.

## Vercel deployment (Option 2: two projects)

### Backend (FastAPI) on Vercel
1) Create a new Vercel project
2) Set Root Directory to `nl2sql-api`
3) Add environment variables:
   - `OPENAI_API_KEY` = your OpenAI key
   - `UI_ORIGIN` = your frontend URL (e.g. `https://your-ui.vercel.app`)
   - `ENV` = `production`
4) Deploy

Health check:
- `https://<your-backend-vercel-domain>/health`

### Frontend (Vite) on Vercel
1) Create a new Vercel project
2) Set Root Directory to `nl2sql-ui`
3) Add environment variables:
   - `VITE_API_BASE_URL` = your backend URL (e.g. `https://your-backend.vercel.app`)
4) Deploy

After deploy, the UI will call the backend via `VITE_API_BASE_URL`.

