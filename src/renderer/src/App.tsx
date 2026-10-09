import { HomeScreen } from './components/HomeScreen'

function App(): React.JSX.Element {
  // Install dir state + first-run wiring (folder picker, persisted settings) is completed in Task 15.
  return <HomeScreen installDir={null} onNeedInstallDir={() => {}} />
}

export default App
