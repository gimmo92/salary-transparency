# Analisi Trasparenza Salariale

Applicazione Vue.js per l'analisi e la visualizzazione della trasparenza retributiva. Carica un file Excel con i dati retributivi: l'app riconosce le colonne (con euristiche o con **Google Gemini**) e calcola gli indicatori di trasparenza (divari di genere, quartili, ecc.).

## Setup

```bash
npm install
```

### Riconoscimento colonne con Google AI (opzionale)

Per usare **Google Gemini** per suggerire automaticamente quale colonna è genere, retribuzione base, bonus, ecc.:

1. Ottieni una API key da [Google AI Studio](https://aistudio.google.com/apikey).

2. **In locale:** copia `.env.example` in `.env.local` e imposta `VITE_GOOGLE_AI_API_KEY=la_tua_chiave`.

3. **Su Vercel:** imposta la variabile direttamente nel progetto:
   - Vercel → tuo progetto → **Settings** → **Environment Variables**
   - Nome: `VITE_GOOGLE_AI_API_KEY`
   - Valore: la tua API key Google
   - Seleziona gli ambienti (Production, Preview, Development) e salva.
   - Esegui un nuovo **Redeploy** perché le variabili vengono lette al build.

Senza API key l'app usa solo le regole euristiche (parole chiave sulle intestazioni). Il mapping AI usa il modello `gemini-2.5-flash`.

### Salvataggio analisi su database (Vercel + PostgreSQL)

L'app salva automaticamente i risultati delle analisi su endpoint serverless `POST /api/analyses`.

Configura `DATABASE_URL` su Vercel:

1. Crea un database PostgreSQL (es. Vercel Postgres, Neon, Supabase).
2. In Vercel, vai su **Project Settings → Environment Variables**.
3. Aggiungi:
   - `DATABASE_URL=postgres://...`
4. Fai **Redeploy** del progetto.

La tabella `analyses` viene creata automaticamente al primo salvataggio.

## Sviluppo

```bash
npm run dev
```

## Build

```bash
npm run build
```

## Preview build

```bash
npm run preview
```

## Repository

[GitHub - gimmo92/salary-transparency](https://github.com/gimmo92/salary-transparency)
