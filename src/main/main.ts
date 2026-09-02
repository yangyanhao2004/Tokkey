import TokkeyApp from './TokkeyApp';
import EvidenceCommandLine from './evidence/EvidenceCommandLine';

// Entry point: the whole main process is driven by the TokkeyApp instance.
const evidenceOptions = EvidenceCommandLine.parse(process.argv);
new TokkeyApp(evidenceOptions ? { ...evidenceOptions, evidenceMode: true } : {}).start();
