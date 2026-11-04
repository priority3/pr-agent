import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import PrApp from './PrApp'
import 'markstream-react/index.css'
import '../globals.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PrApp />
  </StrictMode>,
)
