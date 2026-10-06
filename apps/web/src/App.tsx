import { Route, Routes } from 'react-router'
import { MotionConfig } from 'framer-motion'
import { AppShell } from '@/components/layout/AppShell'
import { UploadOverlay } from '@/components/uploads/UploadOverlay'
import { CurrentUserProvider } from '@/hooks/use-current-user'
import { UploadQueueProvider } from '@/hooks/use-upload-queue'
import { AdminPage } from '@/pages/AdminPage'
import { DashboardPage } from '@/pages/DashboardPage'
import { LoginPage } from '@/pages/LoginPage'
import { NotFoundPage } from '@/pages/NotFoundPage'
import { RegisterPage } from '@/pages/RegisterPage'
import { SettingsPage } from '@/pages/SettingsPage'

export function App() {
  return (
    <MotionConfig reducedMotion="user">
      <CurrentUserProvider>
        <UploadQueueProvider>
          <Routes>
            <Route element={<AppShell />}>
              <Route path="dashboard" element={<DashboardPage />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route path="admin" element={<AdminPage />} />
            </Route>
            <Route index element={<LoginPage />} />
            <Route path="login" element={<LoginPage />} />
            <Route path="register" element={<RegisterPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
          <UploadOverlay />
        </UploadQueueProvider>
      </CurrentUserProvider>
    </MotionConfig>
  )
}