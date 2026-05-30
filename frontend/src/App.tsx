import { Routes, Route } from 'react-router-dom'
import Home from './pages/Home'
import Trip from './pages/Trip'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/trip/:code" element={<Trip />} />
    </Routes>
  )
}
