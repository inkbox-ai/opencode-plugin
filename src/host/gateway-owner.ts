type Handle = { close(): Promise<void> };
type Candidate = { directory: string; start(): Promise<Handle> };
type Slot = { candidates: Set<Candidate>; owner?: Candidate; handle?: Handle; work: Promise<void> };
const slots = new Map<string, Slot>();

export function registerGatewayOwner(
  key: string,
  candidate: Candidate,
  report: (error: unknown) => void,
): () => Promise<void> {
  let slot = slots.get(key);
  if (!slot) {
    slot = { candidates: new Set(), work: Promise.resolve() };
    slots.set(key, slot);
  }
  const current = slot;
  const reconcile = async () => {
    if (current.owner && !current.candidates.has(current.owner)) {
      await current.handle?.close();
      current.owner = undefined;
      current.handle = undefined;
    }
    if (!current.owner) {
      const next = [...current.candidates].sort((a, b) =>
        a.directory.localeCompare(b.directory),
      )[0];
      if (next) {
        current.handle = await next.start();
        current.owner = next;
      }
    }
    if (!current.candidates.size && !current.owner) slots.delete(key);
  };
  const schedule = () => {
    current.work = current.work.catch(() => {}).then(reconcile);
    return current.work;
  };
  current.candidates.add(candidate);
  const timer = setTimeout(() => {
    void schedule().catch(report);
  }, 0);
  return async () => {
    clearTimeout(timer);
    current.candidates.delete(candidate);
    await schedule();
  };
}
