import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// `npm run dev` stays on plain http so the existing LAN workflow is unchanged.
//
// `npm run dev:https` adds a self-signed certificate. Catching an optical
// transfer needs one: getUserMedia is refused outside a secure context, so a
// phone opening http://192.168.x.x:5173 can never open its camera. Accept the
// certificate warning once per device and the camera works.
export default defineConfig(({ mode }) => ({
  plugins: mode === 'https' ? [basicSsl()] : [],
  server: {
    host: true,
  },
}));
