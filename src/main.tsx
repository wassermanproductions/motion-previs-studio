import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { registerControlHandler } from './control/handler';
import './styles.css';

// Bridge agent-control actions (MCP) to the App surface published on window.__mps.
registerControlHandler();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
