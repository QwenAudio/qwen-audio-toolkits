import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { CaptionOverlay } from './views/CaptionOverlay.tsx'

const isCaptionView =
  new URLSearchParams(window.location.search).get('view') === 'captions'
if (isCaptionView) document.documentElement.classList.add('caption-window')

const rootView =
  isCaptionView ? (
    <CaptionOverlay />
  ) : (
    <App />
  )

createRoot(document.getElementById('root')!).render(
  <StrictMode>{rootView}</StrictMode>,
)
