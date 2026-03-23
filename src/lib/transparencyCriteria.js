/**
 * Sistema valutativo trasparenza retributiva (da griglia 4 aree × fattori, scala 1–5).
 * Riferimento: modello "Trasparenza Retributiva" (Fogli Google).
 */

export const TRANSPARENCY_MACRO_AREAS = [
  {
    id: 'competenze',
    label: 'Competenze',
    shortLabel: 'Comp.',
    weightPct: 30,
    factors: [
      {
        id: 'titoliConoscenze',
        label: 'Titoli e conoscenze',
        shortLabel: 'TC',
        description: 'Istruzione e conoscenze tecniche richieste',
        weightPct: 10,
        levels: [
          'Richiede istruzione di base o addestramento pratico elementare',
          'Richiede diploma di scuola superiore o qualifica professionale specifica',
          'Richiede laurea triennale o magistrale per la padronanza di concetti teorici',
          'Richiede specializzazione post-laurea o certificazioni tecniche di alto profilo',
          'Richiede cultura multidisciplinare di livello executive e aggiornamento continuo',
        ],
      },
      {
        id: 'esperienza',
        label: 'Esperienza',
        description: 'Esperienza necessaria per piena autonomia',
        weightPct: 10,
        levels: [
          'Non è richiesta esperienza pregressa; apprendimento rapido nel ruolo',
          'Richiesta esperienza operativa breve (1–2 anni) in contesti analoghi',
          'Richiesta esperienza solida (3–5 anni) per gestire la complessità del ruolo',
          'Richiesta lunga esperienza (oltre 7 anni) con casi d’uso eterogenei',
          'Richiesta esperienza ultra-decennale e visione strategica del settore',
        ],
      },
      {
        id: 'competenzeTrasversali',
        label: 'Competenze trasversali',
        shortLabel: 'CTr',
        description: 'Soft skill rilevanti',
        weightPct: 10,
        levels: [
          'Richiede abilità relazionali di base e rispetto delle norme di convivenza',
          'Richiede capacità di ascolto, collaborazione nel team e precisione',
          'Richiede proattività, problem solving operativo e capacità di influenzamento',
          'Richiede leadership, gestione di conflitti e negoziazione complessa',
          'Richiede pensiero sistemico, intelligenza emotiva e guida del cambiamento',
        ],
      },
    ],
  },
  {
    id: 'responsabilita',
    label: 'Responsabilità',
    shortLabel: 'Resp.',
    weightPct: 40,
    factors: [
      {
        id: 'autonomiaDelega',
        label: 'Autonomia e delega',
        description: 'Grado di discrezionalità decisionale',
        weightPct: 15,
        levels: [
          'Esegue compiti seguendo istruzioni precise; controllo costante',
          'Opera con autonomia su task routinari; segnala eccezioni al supervisore',
          'Gestisce processi interi; ha delega di scelta tra metodologie standard',
          'Definisce programmi operativi; agisce con ampia discrezionalità tecnica',
          'Ha massima ampiezza di delega; definisce e modifica le linee guida aziendali',
        ],
      },
      {
        id: 'impattoObiettivi',
        label: 'Impatto sugli obiettivi',
        shortLabel: 'Imp',
        description: 'Influenza su risultati economici',
        weightPct: 15,
        levels: [
          'L’impatto è limitato alla correttezza formale della propria attività',
          'Contribuisce al raggiungimento di obiettivi tattici di breve periodo del team',
          'Responsabile del raggiungimento di target operativi di reparto o area',
          'Influenza i risultati economici e qualitativi di un’intera funzione',
          'Determina il successo strategico e la sostenibilità del business nel lungo termine',
        ],
      },
      {
        id: 'gestioneRisorseUmane',
        label: 'Gestione risorse umane',
        shortLabel: 'GRU',
        description: 'Numero/complessità risorse gestite',
        weightPct: 10,
        levels: [
          'Non prevede responsabilità di coordinamento verso altri soggetti',
          'Coordina occasionalmente stagisti o supporta l’onboarding di colleghi',
          'Gestisce gerarchicamente un team; responsabile di valutazione e sviluppo',
          'Guida una struttura complessa; coordina manager o team multidisciplinari',
          'Definisce la strategia HR e la cultura organizzativa dell’intera azienda',
        ],
      },
    ],
  },
  {
    id: 'impegno',
    label: 'Impegno',
    shortLabel: 'Impeg.',
    weightPct: 20,
    factors: [
      {
        id: 'sforzoMentale',
        label: 'Sforzo mentale',
        description: 'Complessità analitica e problem solving',
        weightPct: 10,
        levels: [
          'Richiede attenzione visiva o uditiva per compiti semplici e ripetitivi',
          'Richiede concentrazione per la risoluzione di problemi tecnici comuni',
          'Richiede analisi costante di dati variabili e soluzioni non standard',
          'Richiede elevato sforzo interpretativo su scenari nuovi e ambigui',
          'Richiede impegno intellettuale estremo per decisioni ad alto rischio',
        ],
      },
      {
        id: 'tensioneEmotiva',
        label: 'Tensione emotiva',
        shortLabel: 'Ten',
        description: 'Stress relazionale ed emotivo',
        weightPct: 10,
        levels: [
          'Esposizione minima a fattori di stress; relazioni protette e stabili',
          'Gestione di scadenze regolari e interazioni professionali ordinarie',
          'Gestione frequente di urgenze, reclami o scadenze pressanti',
          'Esposizione a situazioni conflittuali critiche o eventi ad alto impatto',
          'Gestione costante di crisi sistemiche e responsabilità emotive elevate',
        ],
      },
    ],
  },
  {
    id: 'condizioni',
    label: 'Condizioni',
    shortLabel: 'Cond.',
    weightPct: 10,
    factors: [
      {
        id: 'ambienteFisico',
        label: 'Ambiente fisico',
        description: 'Rischi e condizioni ambientali',
        weightPct: 5,
        levels: [
          'Ufficio o ambiente confortevole con condizioni climatiche ottimali',
          'Ambiente con rumore moderato, illuminazione variabile o polvere',
          'Ambiente con esposizione a fattori esterni o postazioni ergonomiche limitate',
          'Ambiente con rischi fisici controllati, rumore forte o odori persistenti',
          'Ambiente ostile con rischi residui significativi o disagio fisico costante',
        ],
      },
      {
        id: 'disagioOrganizzativo',
        label: 'Disagio organizzativo',
        shortLabel: 'Dis',
        description: 'Turni, trasferte, isolamento',
        weightPct: 5,
        levels: [
          'Orario di lavoro regolare; assenza di trasferte o reperibilità',
          'Flessibilità d’orario richiesta raramente; trasferte occasionali',
          'Turni regolari, frequenti trasferte o reperibilità programmata',
          'Orari imprevedibili, forte mobilità geografica o turni notturni',
          'Massimo disagio per isolamento, mobilità internazionale o reperibilità totale',
        ],
      },
    ],
  },
]

/** Lista piatta fattori nell’ordine di visualizzazione colonne */
export const TRANSPARENCY_FLAT_FACTORS = TRANSPARENCY_MACRO_AREAS.flatMap((a) =>
  a.factors.map((f) => ({
    ...f,
    areaId: a.id,
    areaLabel: a.label,
    areaWeightPct: a.weightPct,
  })),
)

export const TRANSPARENCY_FACTOR_IDS = TRANSPARENCY_FLAT_FACTORS.map((f) => f.id)

/** Chiavi `tr*` su persona/ruolo (camelCase dopo tr) */
export function trFieldName(factorId) {
  return `tr${factorId.charAt(0).toUpperCase()}${factorId.slice(1)}`
}

/** Peso fattore 0–1 */
export function transparencyWeightsMap() {
  const m = {}
  for (const f of TRANSPARENCY_FLAT_FACTORS) {
    m[f.id] = f.weightPct / 100
  }
  return m
}

/**
 * Punti parametrici su scala 100: voto 1–5 su un fattore con peso w% sul totale.
 * Contributo = w × voto / 5. Esempio: voto 4/5 e peso 10% → 10 × 4 / 5 = 8 pt.
 * La somma su tutti i fattori (pesi che sommano a 100) dà max 100 se tutti i voti sono 5.
 */
export function transparencyParametricPointsFromFactor(score1to5, weightPct) {
  const s = Number(score1to5)
  const w = Number(weightPct)
  if (!Number.isFinite(s) || !Number.isFinite(w)) return 0
  return (w * s) / 5
}
