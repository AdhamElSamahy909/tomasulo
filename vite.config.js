import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc"; // This line might be 'plugin-react' or 'plugin-react-swc' depending on your setup
import tailwindcss from "@tailwindcss/vite"; // <--- ADD THIS IMPORT

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(), // <--- ADD THIS FUNCTION
  ],
});
