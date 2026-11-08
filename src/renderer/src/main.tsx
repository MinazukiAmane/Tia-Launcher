import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'

async function start(): Promise<void> {
  if (!window.csore) await import('./tauriBridge')
  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
}

void start()
