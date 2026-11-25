import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import './index.css'
import { FileViewerProvider } from './components/chat/FileViewer'
import { BRAND_NAME } from '@/lib/brand';

// The tab title follows the brand at runtime, so index.html stays the same in every fork.
document.title = BRAND_NAME;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <FileViewerProvider>
      <App />
    </FileViewerProvider>
  </React.StrictMode>,
)
