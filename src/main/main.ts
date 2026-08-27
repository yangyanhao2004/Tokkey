import TokiieApp from './TokiieApp';
import EvidenceCommandLine from './evidence/EvidenceCommandLine';

// Entry point: the whole main process is driven by the TokiieApp instance.
const evidenceOptions = EvidenceCommandLine.parse(process.argv);
new TokiieApp(evidenceOptions ? { ...evidenceOptions, evidenceMode: true } : {}).start();
