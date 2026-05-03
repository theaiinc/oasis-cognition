import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import './index.css'
import { FileViewerProvider } from './components/chat/FileViewer'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <FileViewerProvider>
      <App />
    </FileViewerProvider>
  </React.StrictMode>,
)
