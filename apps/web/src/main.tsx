import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router';
import './index.css';
import { AuthProvider } from './lib/auth';
import { Home } from './pages/Home';
import { JoinPage } from './pages/JoinPage';
import { RunPage } from './pages/RunPage';
import { PlayPage } from './pages/PlayPage';
import { RecapPage } from './pages/RecapPage';
import { HallPage } from './pages/HallPage';
import { OverlayPage } from './pages/OverlayPage';
import { ProfilesPage } from './pages/ProfilesPage';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '')}>
      <AuthProvider>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/join/:code" element={<JoinPage />} />
          <Route path="/run/:id" element={<RunPage />} />
          <Route path="/run/:id/recap" element={<RecapPage />} />
          <Route path="/play" element={<PlayPage />} />
          <Route path="/hall" element={<HallPage />} />
          <Route path="/profiles" element={<ProfilesPage />} />
          <Route path="/overlay/:id" element={<OverlayPage />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
