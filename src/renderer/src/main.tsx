import './assets/main.css'
import './assets/github.css'
import './assets/activity.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { RootBoundary } from './components/shell/ErrorBoundary'
import { applyCachedTheme } from './lib/theme'

applyCachedTheme()

// A file dragged onto the window is not a page to open (the main process blocks the
// navigation too). Views that take drops of their own handle them before this.
for (const type of ['dragover', 'drop'] as const) {
  document.addEventListener(type, (e) => {
    if (!e.dataTransfer?.types.includes('Files') || e.defaultPrevented) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'none'
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RootBoundary>
      <App />
    </RootBoundary>
  </StrictMode>
)
