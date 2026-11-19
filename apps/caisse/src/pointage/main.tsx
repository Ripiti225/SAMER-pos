import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppPointage } from './AppPointage';
import '@pos/theme/theme.css';
import '../index.css';

createRoot(document.getElementById('racine')!).render(
  <StrictMode>
    <AppPointage />
  </StrictMode>,
);
