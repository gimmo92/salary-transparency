<script setup>
</script>

<template>
  <div class="app">
    <header class="header">
      <h1>Analisi Trasparenza Salariale</h1>
      <p class="subtitle">Strumento per l'analisi e la visualizzazione della trasparenza retributiva</p>
    </header>
    <main class="main">
      <p>Benvenuto nell'applicazione. Qui potrai esplorare dati e analisi sulla trasparenza salariale.</p>
    </main>
  </div>
</template>

<style scoped>
.app {
  min-height: 100vh;
  font-family: system-ui, -apple-system, sans-serif;
  background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
  color: #e8e8e8;
}

.header {
  padding: 2rem;
  text-align: center;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.header h1 {
  margin: 0;
  font-size: 1.75rem;
  font-weight: 700;
  letter-spacing: -0.02em;
}

.subtitle {
  margin: 0.5rem 0 0;
  font-size: 1rem;
  opacity: 0.85;
}

.main {
  padding: 2rem;
  max-width: 48rem;
  margin: 0 auto;
}
</style>
