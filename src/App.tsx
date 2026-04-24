import { Navigate, Route, Routes } from "react-router";
import ChatLayout from "./layouts/ChatLayout";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<ChatLayout />} />
      <Route path="/c/:id" element={<ChatLayout />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
