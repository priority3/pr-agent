import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import PrChatPage from './PrChat'
import '../globals.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PrChatPage />
  </StrictMode>,
)
