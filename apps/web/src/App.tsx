import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { User } from 'oidc-client-ts';
import { ArrowDownToLine, ArrowLeftRight, CircleDollarSign, Cloud, CloudOff, Minus, Plus, Settings, ShoppingBasket, Trash2, Undo2 } from 'lucide-react';
import { api, ApiError } from './api';
import { accessTokenFor, callbackOrStoredUser, createUserManager, isAuthenticated, startOidcStateCleanup } from './auth';
import { Button } from './components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from './components/ui/card';
import { Dialog } from './components/ui/dialog';
import { Input } from './components/ui/input';
import { changeDue, formatMoney, parseCurrencyToCents, totals } from './money';
import { changeLineQuantity, discardActiveCart, loadState, queueActiveCart, recordDrawerChange, updateState } from './store';
import type { CartLine, PersistedState, Product, RuntimeConfig } from './types';

type View = 'checkout' | 'products' | 'ledger';
type DialogMode = 'custom' | 'donation' | 'manual-set' | 'manual-subtract' | null;
type CartUndo = { before: PersistedState['active_cart']; after: PersistedState['active_cart'] };

function newId() { return crypto.randomUUID(); }
function sameCart(left: PersistedState['active_cart'], right: PersistedState['active_cart']) {
  return left.cart_uuid === right.cart_uuid && JSON.stringify(left.lines) === JSON.stringify(right.lines);
}

export default function App() {
  const [state, setState] = useState<PersistedState | null>(null);
  const [runtime, setRuntime] = useState<RuntimeConfig | null>(null);
  const [manager, setManager] = useState<ReturnType<typeof createUserManager> | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const authRedirecting = useRef(false);
  const signingOut = useRef(false);
  const authInitialization = useRef<{ runtime: RuntimeConfig; manager: ReturnType<typeof createUserManager>; session: Promise<User | null> } | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [managedProducts, setManagedProducts] = useState<Product[]>([]);
  const [view, setView] = useState<View>('checkout');
  const [dialogMode, setDialogMode] = useState<DialogMode>(null);
  const [dialogAmount, setDialogAmount] = useState('');
  const [dialogError, setDialogError] = useState('');
  const [received, setReceived] = useState('');
  const [cartUndoStack, setCartUndoStack] = useState<CartUndo[]>([]);
  const [undoing, setUndoing] = useState(false);
  const undoingRef = useRef(false);
  const [status, setStatus] = useState('Bereit');
  const [loadingError, setLoadingError] = useState('');
  const [online, setOnline] = useState(navigator.onLine);
  const [productDraft, setProductDraft] = useState<Product | null>(null);
  const [productForm, setProductForm] = useState({ name: '', display_name: '', price: '', position: '14', enabled: true });
  const [productError, setProductError] = useState('');

  const identityEmail = user?.profile.email ?? state?.email ?? null;
  const sums = useMemo(() => totals(state?.active_cart.lines ?? []), [state?.active_cart.lines]);
  const pendingCount = state?.pending.filter(item => item.status === 'queued').length ?? 0;

  useEffect(() => {
    loadState().then(setState).catch(error => setLoadingError(`Browser storage could not be opened: ${String(error)}`));
    api.runtimeConfig().then(setRuntime).catch(error => setLoadingError(`Could not load app configuration: ${String(error)}`));
    const updateOnline = () => setOnline(navigator.onLine);
    window.addEventListener('online', updateOnline);
    window.addEventListener('offline', updateOnline);
    return () => { window.removeEventListener('online', updateOnline); window.removeEventListener('offline', updateOnline); };
  }, []);

  useEffect(() => {
    if (!runtime) return;
    let initialization = authInitialization.current;
    if (!initialization || initialization.runtime !== runtime) {
      const auth = createUserManager(runtime);
      initialization = { runtime, manager: auth, session: callbackOrStoredUser(auth) };
      authInitialization.current = initialization;
    }
    const auth = initialization.manager;
    setManager(auth);
    let active = true;
    const stopOidcStateCleanup = startOidcStateCleanup(auth);
    const redirectToIdp = () => {
      if (!active || authRedirecting.current || signingOut.current) return;
      authRedirecting.current = true;
      void auth.signinRedirect().catch(error => {
        authRedirecting.current = false;
        if (active) setLoadingError(`Sign-in could not be started: ${String(error)}`);
      });
    };
    const onUserLoaded = (loaded: User) => {
      if (!active) return;
      if (!isAuthenticated(loaded)) {
        setUser(null);
        setAuthReady(false);
        redirectToIdp();
        return;
      }
      authRedirecting.current = false;
      setUser(loaded);
      setAuthReady(true);
    };
    const onUserUnloaded = () => {
      if (!active) return;
      setUser(null);
      setAuthReady(false);
      redirectToIdp();
    };
    auth.events.addUserLoaded(onUserLoaded);
    auth.events.addUserUnloaded(onUserUnloaded);
    initialization.session.then(current => {
      if (!active) return;
      if (isAuthenticated(current)) onUserLoaded(current);
      else redirectToIdp();
    }).catch(error => {
      if (active) setLoadingError(`Sign-in could not be completed: ${String(error)}`);
    });
    return () => {
      active = false;
      stopOidcStateCleanup();
      auth.events.removeUserLoaded(onUserLoaded);
      auth.events.removeUserUnloaded(onUserUnloaded);
    };
  }, [runtime]);

  useEffect(() => {
    if (!manager || !user?.access_token) return;
    let active = true;
    accessTokenFor(manager).then(token => {
      if (active && token) return api.products(token).then(result => { setProducts(result); setManagedProducts(result); });
    }).catch(error => {
      if (active && online) setStatus(`Catalog could not be loaded: ${message(error)}`);
    });
    return () => { active = false; };
  }, [manager, user?.access_token, online]);

  useEffect(() => {
    if (!state || !user?.profile.email || state.email === user.profile.email) return;
    commit(current => ({ ...current, email: user.profile.email ?? null })).catch(() => setStatus('Could not save the operator identity locally'));
  }, [user?.profile.email, state?.email]);

  const commit = useCallback(async (transform: (current: PersistedState) => PersistedState) => {
    const next = await updateState(transform);
    setState(next);
    return next;
  }, []);

  const commitCartEdit = useCallback(async (transform: (current: PersistedState) => PersistedState) => {
    const undo = { current: null as CartUndo | null };
    const next = await commit(current => {
      const updated = transform(current);
      if (updated !== current && updated.active_cart !== current.active_cart) {
        undo.current = { before: structuredClone(current.active_cart), after: structuredClone(updated.active_cart) };
      }
      return updated;
    });
    if (undo.current) setCartUndoStack(stack => [...stack, undo.current!]);
    return next;
  }, [commit]);

  const addLedgerDelta = (current: PersistedState, delta: number, reason: 'sale' | 'donation' | 'reversal', cartUuid: string) =>
    recordDrawerChange(current, delta, reason, identityEmail, cartUuid);

  const addProduct = useCallback(async (product: Product) => {
    if (!state) return;
    try {
      await commitCartEdit(current => {
        const cartUuid = current.active_cart.cart_uuid;
        const existing = current.active_cart.lines.find(line => line.kind === 'product' && line.product_id === product.id);
        const lines = existing
          ? current.active_cart.lines.map(line => line.id === existing.id ? changeLineQuantity(line, line.quantity + 1) : line)
          : [...current.active_cart.lines, { id: newId(), kind: 'product' as const, product_id: product.id, description: product.name, unit_amount_cents: product.price_cents, quantity: 1, line_total_cents: product.price_cents }];
        return { ...addLedgerDelta(current, product.price_cents, 'sale', cartUuid), active_cart: { ...current.active_cart, lines } };
      });
      setStatus(`${product.name} added`);
    } catch (error) { setStatus(`Cart change was not saved: ${message(error)}`); }
  }, [state, commitCartEdit, identityEmail]);

  const changeQuantity = useCallback(async (line: CartLine, amount: number) => {
    if (!state || line.kind === 'donation') return;
    try {
      await commitCartEdit(current => {
        const actual = current.active_cart.lines.find(item => item.id === line.id);
        if (!actual) return current;
        const nextQuantity = actual.quantity + amount;
        if (nextQuantity < 1) return current;
        const delta = actual.unit_amount_cents * amount;
        const lines = current.active_cart.lines.map(item => item.id === line.id ? changeLineQuantity(item, nextQuantity) : item);
        return { ...addLedgerDelta(current, delta, delta > 0 ? 'sale' : 'reversal', current.active_cart.cart_uuid), active_cart: { ...current.active_cart, lines } };
      });
    } catch (error) { setStatus(`Quantity change was not saved: ${message(error)}`); }
  }, [state, commitCartEdit, identityEmail]);

  const removeLine = useCallback(async (line: CartLine) => {
    if (!state) return;
    try {
      await commitCartEdit(current => {
        const actual = current.active_cart.lines.find(item => item.id === line.id);
        if (!actual) return current;
        const lines = current.active_cart.lines.filter(item => item.id !== line.id);
        return { ...addLedgerDelta(current, -actual.line_total_cents, 'reversal', current.active_cart.cart_uuid), active_cart: { ...current.active_cart, lines } };
      });
    } catch (error) { setStatus(`Line removal was not saved: ${message(error)}`); }
  }, [state, commitCartEdit, identityEmail]);

  const undoLastCartEdit = async () => {
    if (undoingRef.current || cartUndoStack.length === 0) return;
    undoingRef.current = true;
    setUndoing(true);
    const cartUndo = cartUndoStack[cartUndoStack.length - 1];
    let undone = false;
    try {
      await commit(current => {
        if (!sameCart(current.active_cart, cartUndo.after)) return current;
        const delta = totals(cartUndo.before.lines).due - totals(current.active_cart.lines).due;
        const reversed = delta === 0 ? current : recordDrawerChange(current, delta, 'reversal', identityEmail, current.active_cart.cart_uuid);
        undone = true;
        return { ...reversed, active_cart: structuredClone(cartUndo.before) };
      });
      setCartUndoStack(stack => {
        if (stack[stack.length - 1] !== cartUndo) return stack;
        return undone ? stack.slice(0, -1) : [];
      });
      setStatus(undone ? 'Last cart change undone' : 'Cart changed elsewhere; undo is no longer available');
    } catch (error) { setStatus(`Could not undo the last cart change: ${message(error)}`); }
    finally { undoingRef.current = false; setUndoing(false); }
  };

  const openAmountDialog = (mode: DialogMode) => { setDialogAmount(''); setDialogError(''); setDialogMode(mode); };

  const submitAmount = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!state || !dialogMode) return;
    if (dialogMode === 'manual-set') {
      const target = parseSignedCurrency(dialogAmount);
      if (target === null) { setDialogError('Enter a valid signed EUR amount (for example −2.50 or 12,34).'); return; }
      try {
        await commit(current => recordDrawerChange(current, target - current.cash_balance_cents, 'manual_set', identityEmail));
        setStatus('Drawer balance updated'); setDialogMode(null);
      } catch (error) { setDialogError(`Could not save drawer adjustment: ${message(error)}`); }
      return;
    }
    const cents = parseCurrencyToCents(dialogAmount);
    if (cents === null) { setDialogError('Enter a positive amount with at most two decimal places.'); return; }
    try {
      if (dialogMode === 'manual-subtract') {
        await commit(current => recordDrawerChange(current, -cents, 'manual_subtract', identityEmail));
      } else {
        const kind = dialogMode;
        await commitCartEdit(current => {
          const cartUuid = current.active_cart.cart_uuid;
          const line: CartLine = { id: newId(), kind, product_id: null, description: kind === 'custom' ? 'Sonstiger Artikel' : 'Spende', unit_amount_cents: cents, quantity: 1, line_total_cents: cents };
          return { ...addLedgerDelta(current, cents, kind === 'custom' ? 'sale' : 'donation', cartUuid), active_cart: { ...current.active_cart, lines: [...current.active_cart.lines, line] } };
        });
      }
      setDialogMode(null); setStatus(dialogMode === 'manual-subtract' ? 'Drawer adjustment saved' : 'Item added');
    } catch (error) { setDialogError(`Could not save this change: ${message(error)}`); }
  };

  const discardCart = async () => {
    if (!state || state.active_cart.lines.length === 0) return;
    if (!window.confirm('Discard this sale? Drawer effects will be reversed.')) return;
    try {
      await commit(current => discardActiveCart(current, identityEmail));
      setCartUndoStack([]);
      setReceived(''); setStatus('Sale discarded and drawer entries reversed');
    } catch (error) { setStatus(`Sale was not discarded: ${message(error)}`); }
  };

  const tryUpload = useCallback(async (current: PersistedState) => {
    if (!manager || !online) return;
    const token = await accessTokenFor(manager);
    if (!token) return;
    for (const pending of current.pending) {
      if (pending.status === 'blocked') continue;
      try {
        const result = await api.submitInvoice(token, pending.snapshot);
        current = await updateState(stateNow => ({ ...stateNow, pending: stateNow.pending.filter(item => item.snapshot.cart_uuid !== pending.snapshot.cart_uuid) }));
        setState(current);
        setStatus(`Invoice stored (${result.invoice_id})`);
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          current = await updateState(stateNow => ({ ...stateNow, pending: stateNow.pending.map(item => item.snapshot.cart_uuid === pending.snapshot.cart_uuid ? { ...item, status: 'blocked', message: error.message } : item) }));
          setState(current);
          setStatus(`Invoice blocked: ${error.message}`);
        } else {
          setStatus(`Invoice queued for retry: ${message(error)}`);
          return;
        }
      }
    }
  }, [manager, online]);

  useEffect(() => {
    if (!state?.pending.some(item => item.status === 'queued') || !online || !manager) return;
    void tryUpload(state);
    const retryTimer = window.setInterval(() => void tryUpload(state), 15_000);
    return () => window.clearInterval(retryTimer);
  }, [state, online, manager, tryUpload]);

  const saveSale = async () => {
    if (!state || state.active_cart.lines.length === 0) return;
    try {
      await commit(current => queueActiveCart(current));
      setCartUndoStack([]);
      setReceived('');
      setStatus(online ? 'Invoice saved locally; uploading…' : 'Invoice saved to the offline queue');
    } catch (error) { setStatus(`Sale was not saved: ${message(error)}`); }
  };

  const saveProduct = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!manager || !user) { setProductError('Sign in to edit products.'); return; }
    const cents = parseCurrencyToCents(productForm.price);
    const position = Number(productForm.position);
    if (!productForm.name.trim() || cents === null || !Number.isInteger(position) || position < 0) {
      setProductError('Enter a name, positive EUR price, and non-negative whole-number order.'); return;
    }
    const input = { name: productForm.name.trim(), display_name: productForm.display_name.trim() || null, price_cents: cents, position, enabled: productForm.enabled };
    try {
      const token = await accessTokenFor(manager);
      if (!token) { setProductError('Your session expired. Sign in again to edit products.'); return; }
      const product = productDraft ? await api.updateProduct(token, productDraft.id, input) : await api.createProduct(token, input);
      setManagedProducts(old => [...old.filter(item => item.id !== product.id), product].sort((a, b) => a.position - b.position || a.id - b.id));
      setProductDraft(null); setProductForm({ name: '', display_name: '', price: '', position: String(managedProducts.length + 1), enabled: true }); setProductError(''); setStatus('Product saved');
    } catch (error) { setProductError(message(error)); }
  };

  const editProduct = (product: Product) => {
    setProductDraft(product);
    setProductForm({ name: product.name, display_name: product.display_name ?? '', price: (product.price_cents / 100).toFixed(2), position: String(product.position), enabled: product.enabled });
    setProductError('');
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || (event.target instanceof HTMLElement && event.target.isContentEditable) || dialogMode || view !== 'checkout') return;
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'z') {
        if (cartUndoStack.length > 0) { event.preventDefault(); void undoLastCartEdit(); }
        return;
      }
      const hotkeys = ['q', 'w', 'e', 'a', 's', 'd', 'y', 'x', 'c', 'r', 'f', 'v'];
      const idx = hotkeys.indexOf(event.key.toLowerCase());
      if (idx >= 0) {
        const available = products.filter(product => product.enabled);
        if (available[idx]) { event.preventDefault(); void addProduct(available[idx]); }
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        setView('checkout');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [products, addProduct, dialogMode, view, cartUndoStack.length, undoLastCartEdit]);

  if (loadingError && (!state || !runtime || !manager || !authReady)) return <main className="mx-auto max-w-xl p-8"><Card><CardHeader><CardTitle>Sell Guy could not start</CardTitle></CardHeader><CardContent><p role="alert" className="text-destructive">{loadingError}</p><Button className="mt-5" onClick={() => location.reload()}>Try again</Button></CardContent></Card></main>;
  if (!state || !runtime || !manager || !authReady || !user) return <main className="grid min-h-screen place-items-center p-5"><div className="text-center"><div className="mx-auto mb-3 h-8 w-8 animate-spin rounded-full border-4 border-primary border-r-transparent"/><p className="text-muted-foreground">Starting Sell Guy…</p></div></main>;

  const dialogTitle = dialogMode === 'custom' ? 'Sonstiger Artikel' : dialogMode === 'donation' ? 'Spende' : dialogMode === 'manual-set' ? 'Kassenstand festlegen' : 'Betrag aus Kasse entnehmen';
  const receivedCents = received === '' ? null : parseCurrencyToCents(received, true);
  const change = receivedCents === null ? null : changeDue(receivedCents, sums.due);

  return <div className="min-h-screen bg-muted/40">
    <header className="sticky top-0 z-20 border-b bg-background/95 backdrop-blur">
      <div className="mx-auto flex max-w-[1760px] flex-wrap items-center justify-between gap-3 px-4 py-3 lg:px-6">
        <a className="text-xl font-bold tracking-tight" href="#checkout" onClick={event => { event.preventDefault(); setView('checkout'); }}>Sell Guy<span className="text-primary">.</span></a>
        <nav aria-label="Main navigation" className="flex items-center gap-1">
          <Button variant={view === 'checkout' ? 'secondary' : 'ghost'} className="h-11 touch-manipulation" onClick={() => setView('checkout')}><ShoppingBasket size={17}/> Checkout</Button>
          <Button variant={view === 'products' ? 'secondary' : 'ghost'} className="h-11 touch-manipulation" onClick={() => { setView('products'); if (manager) void accessTokenFor(manager).then(token => token ? api.products(token).then(setManagedProducts) : undefined).catch(error => setProductError(message(error))); }}><Settings size={17}/> Products</Button>
          <Button variant={view === 'ledger' ? 'secondary' : 'ghost'} className="h-11 touch-manipulation" onClick={() => setView('ledger')}><ArrowLeftRight size={17}/> Drawer</Button>
        </nav>
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <span className="hidden sm:inline">{identityEmail ?? 'Operator'}</span>
          <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${online ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-900'}`}><span className={`h-1.5 w-1.5 rounded-full ${online ? 'bg-emerald-600' : 'bg-amber-600'}`}/>{online ? 'Online' : 'Offline'}</span>
          {pendingCount > 0 && <span className="inline-flex items-center gap-1 text-xs"><Cloud size={15}/> {pendingCount} pending</span>}
          <Button size="sm" variant="outline" onClick={() => { signingOut.current = true; void manager.signoutRedirect().catch(error => { signingOut.current = false; setStatus(`Sign-out could not be started: ${String(error)}`); }); }}>Sign out</Button>
        </div>
      </div>
    </header>

    <main className="mx-auto max-w-[1760px] p-4 lg:px-6 lg:py-5">
      {view === 'checkout' && <div className="grid items-start gap-4 lg:grid-cols-2">
        <section className="space-y-4">
          <div className="flex items-end justify-between gap-3"><div><p className="text-sm font-medium text-primary">CHECKOUT</p><h1 className="mt-1 text-2xl font-bold">Select items</h1></div><div className="text-right text-sm text-muted-foreground">Sale ID<br/><span className="font-mono text-xs">{state.active_cart.cart_uuid.slice(0, 8)}</span></div></div>
          {products.filter(product => product.enabled).length === 0 && <Card><CardContent className="p-6 text-sm text-muted-foreground">No products are configured yet. Add them in Products.</CardContent></Card>}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-3">
            {products.filter(product => product.enabled).map((product, index) => <button key={product.id} onClick={() => void addProduct(product)} className="group flex min-h-28 touch-manipulation flex-col justify-between rounded-xl border bg-card p-3 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-primary/50 hover:shadow-md active:translate-y-0 active:scale-[0.98] active:border-primary/60 active:bg-primary/5 active:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:p-4">
              <span className="font-semibold leading-snug">{product.display_name ?? product.name}</span><span className="mt-3 flex items-center justify-between"><span className="text-lg font-bold text-primary">{formatMoney(product.price_cents)}</span><kbd className="keyboard-shortcut rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{['Q','W','E','A','S','D','Y','X','C','R','F','V'][index] ?? ''}</kbd></span>
            </button>)}
            <button onClick={() => openAmountDialog('custom')} className="group flex min-h-28 touch-manipulation flex-col justify-between rounded-xl border bg-muted/70 p-3 text-left text-muted-foreground shadow-sm transition hover:-translate-y-0.5 hover:border-muted-foreground/30 hover:bg-muted hover:shadow-md active:translate-y-0 active:scale-[0.98] active:border-muted-foreground/50 active:bg-muted active:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:p-4">
              <span className="font-semibold leading-snug">Sonstiger Artikel</span><span className="flex items-center gap-2 text-sm font-medium"><Plus size={19}/>Betrag eingeben</span>
            </button>
            <button onClick={() => openAmountDialog('donation')} className="group flex min-h-28 touch-manipulation flex-col justify-between rounded-xl border bg-muted/70 p-3 text-left text-muted-foreground shadow-sm transition hover:-translate-y-0.5 hover:border-muted-foreground/30 hover:bg-muted hover:shadow-md active:translate-y-0 active:scale-[0.98] active:border-muted-foreground/50 active:bg-muted active:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:p-4">
              <span className="font-semibold leading-snug">Spende</span><span className="flex items-center gap-2 text-sm font-medium"><CircleDollarSign size={19}/>Betrag eingeben</span>
            </button>
          </div>
        </section>

        <section className="xl:sticky xl:top-24">
          <Card className="overflow-hidden">
            <CardHeader className="border-b bg-card"><div className="flex items-center justify-between"><CardTitle>Current sale</CardTitle><div className="flex items-center gap-3"><span className="text-sm text-muted-foreground">{state.active_cart.lines.length} line{state.active_cart.lines.length === 1 ? '' : 's'}</span><Button variant="outline" className="h-11 touch-manipulation px-3" onClick={() => void undoLastCartEdit()} disabled={cartUndoStack.length === 0 || undoing} title="Undo last (Ctrl+Z / ⌘Z)" aria-keyshortcuts="Control+Z Meta+Z"><Undo2 size={16}/>Undo last</Button></div></div></CardHeader>
            <CardContent className="p-0">
              <div className="max-h-[38vh] min-h-24 overflow-y-auto">
                {state.active_cart.lines.length === 0 ? <div className="grid min-h-24 place-items-center p-4 text-center text-sm text-muted-foreground">Select a product or add a custom item to start.</div> : <ul className="divide-y">
                  {state.active_cart.lines.map(line => <li key={line.id} className="flex items-center gap-2 px-3 py-3 sm:gap-3 sm:px-4">
                    <div className="min-w-0 flex-1"><p className="truncate font-medium">{line.description}{line.kind === 'donation' && <span className="ml-2 rounded bg-violet-100 px-1.5 py-0.5 text-xs text-violet-800">donation</span>}</p><p className="mt-1 text-sm text-muted-foreground">{formatMoney(line.unit_amount_cents)} each</p></div>
                    {line.kind !== 'donation' && <div className="flex items-center gap-1"><Button aria-label={`Decrease ${line.description}`} size="icon" variant="ghost" className="h-11 w-11 touch-manipulation" onClick={() => void changeQuantity(line, -1)}><Minus size={17}/></Button><span className="w-7 text-center text-sm tabular-nums">{line.quantity}</span><Button aria-label={`Increase ${line.description}`} size="icon" variant="ghost" className="h-11 w-11 touch-manipulation" onClick={() => void changeQuantity(line, 1)}><Plus size={17}/></Button></div>}
                    <span className="w-20 text-right font-semibold tabular-nums">{formatMoney(line.line_total_cents)}</span>
                    <Button aria-label={`Remove ${line.description}`} size="icon" variant="ghost" className="h-11 w-11 touch-manipulation text-muted-foreground hover:text-destructive" onClick={() => void removeLine(line)}><Trash2 size={18}/></Button>
                  </li>)}
                </ul>}
              </div>
              <div className="space-y-2 border-t bg-muted/30 p-4">
                <div className="flex justify-between text-sm"><span className="text-muted-foreground">Chargeable total</span><span className="font-medium tabular-nums">{formatMoney(sums.chargeable)}</span></div>
                <div className="flex justify-between text-sm"><span className="text-muted-foreground">Donations</span><span className="font-medium tabular-nums">{formatMoney(sums.donations)}</span></div>
                <div className="flex justify-between border-t pt-2"><span className="font-semibold">Cash amount due</span><span className="text-xl font-bold tabular-nums">{formatMoney(sums.due)}</span></div>
                <div className="grid grid-cols-[1fr_auto] items-center gap-3 pt-2"><label htmlFor="received" className="text-sm text-muted-foreground">Amount received</label><Input id="received" inputMode="decimal" placeholder="0,00" className="h-11 w-36 text-right tabular-nums" value={received} onChange={event => setReceived(event.target.value)}/></div>
                {received !== '' && <div aria-live="polite" className={`flex justify-between rounded-md p-2 text-sm font-semibold ${receivedCents === null || (change ?? 0) < 0 ? 'bg-destructive/10 text-destructive' : 'bg-emerald-100 text-emerald-900'}`}><span>{receivedCents === null ? 'Enter a valid amount' : change! < 0 ? 'Insufficient amount' : 'Change due'}</span><span>{receivedCents !== null && formatMoney(change!)}</span></div>}
                <div className="grid grid-cols-2 gap-2 pt-2"><Button className="h-12 touch-manipulation" variant="outline" onClick={() => void discardCart()} disabled={state.active_cart.lines.length === 0}>Verwerfen</Button><Button className="h-12 touch-manipulation" onClick={() => void saveSale()} disabled={state.active_cart.lines.length === 0}><ArrowDownToLine size={17}/> Speichern</Button></div>
                <p className="min-h-5 text-center text-xs text-muted-foreground" aria-live="polite">{status}</p>
              </div>
            </CardContent>
          </Card>
          <div className="mt-3 flex items-center justify-between rounded-lg border bg-card px-4 py-3 text-sm"><span className="text-muted-foreground">Cash drawer balance</span><span className="font-semibold tabular-nums">{formatMoney(state.cash_balance_cents)}</span></div>
        </section>
      </div>}

      {view === 'products' && <section className="mx-auto max-w-5xl space-y-5">
        <div><p className="text-sm font-medium text-primary">CONFIGURATION</p><h1 className="mt-1 text-2xl font-bold">Products</h1><p className="mt-1 text-muted-foreground">Catalog changes are stored centrally and apply after the next checkout reload.</p></div>
        <Card><CardHeader><CardTitle>{productDraft ? `Edit ${productDraft.name}` : 'Add product'}</CardTitle></CardHeader><CardContent><form className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5" onSubmit={saveProduct}>
          <label className="space-y-1 text-sm">Name<Input required value={productForm.name} onChange={event => setProductForm({ ...productForm, name: event.target.value })}/></label>
          <label className="space-y-1 text-sm">Display label (optional)<Input value={productForm.display_name} onChange={event => setProductForm({ ...productForm, display_name: event.target.value })}/></label>
          <label className="space-y-1 text-sm">Price (EUR)<Input inputMode="decimal" required placeholder="4,00" value={productForm.price} onChange={event => setProductForm({ ...productForm, price: event.target.value })}/></label>
          <label className="space-y-1 text-sm">Order<Input type="number" min="0" step="1" value={productForm.position} onChange={event => setProductForm({ ...productForm, position: event.target.value })}/></label>
          <label className="flex items-center gap-2 pt-6 text-sm"><input type="checkbox" checked={productForm.enabled} onChange={event => setProductForm({ ...productForm, enabled: event.target.checked })}/> Active</label>
          <div className="flex items-center gap-2 sm:col-span-2 lg:col-span-5"><Button type="submit" disabled={!user || !online}>{productDraft ? 'Save changes' : 'Create product'}</Button>{productDraft && <Button type="button" variant="outline" onClick={() => { setProductDraft(null); setProductForm({ name: '', display_name: '', price: '', position: String(managedProducts.length + 1), enabled: true }); }}>Cancel</Button>}</div>
          {productError && <p role="alert" className="text-sm text-destructive sm:col-span-2 lg:col-span-5">{productError}</p>}
        </form></CardContent></Card>
        <Card><div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="border-b bg-muted/50"><tr><th className="p-4">Product</th><th className="p-4">Price</th><th className="p-4">Order</th><th className="p-4">Status</th><th className="p-4"/></tr></thead><tbody>{managedProducts.map(product => <tr key={product.id} className="border-b last:border-0"><td className="p-4 font-medium">{product.name}{product.display_name && <span className="block text-xs text-muted-foreground">{product.display_name}</span>}</td><td className="p-4 tabular-nums">{formatMoney(product.price_cents)}</td><td className="p-4">{product.position}</td><td className="p-4"><span className={product.enabled ? 'text-emerald-700' : 'text-muted-foreground'}>{product.enabled ? 'Active' : 'Inactive'}</span></td><td className="p-4 text-right"><Button size="sm" variant="outline" onClick={() => editProduct(product)}>Edit</Button></td></tr>)}</tbody></table></div></Card>
      </section>}

      {view === 'ledger' && <section className="mx-auto max-w-5xl space-y-5">
        <div><p className="text-sm font-medium text-primary">CASH DRAWER</p><h1 className="mt-1 text-2xl font-bold">Balance & audit</h1><p className="mt-1 text-muted-foreground">Ledger entries are stored locally in this browser profile.</p></div>
        <Card><CardContent className="flex flex-wrap items-center justify-between gap-4 p-6"><div><p className="text-sm text-muted-foreground">Current balance</p><p className="mt-1 text-3xl font-bold tabular-nums">{formatMoney(state.cash_balance_cents)}</p></div><div className="flex gap-2"><Button variant="outline" onClick={() => openAmountDialog('manual-set')}>Set balance</Button><Button variant="outline" onClick={() => openAmountDialog('manual-subtract')}>Subtract</Button></div></CardContent></Card>
        <Card><CardHeader><CardTitle>Drawer history</CardTitle></CardHeader><CardContent className="p-0"><div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="border-y bg-muted/50"><tr><th className="p-3">Time</th><th className="p-3">Reason</th><th className="p-3">Operator</th><th className="p-3 text-right">Change</th><th className="p-3 text-right">Balance</th></tr></thead><tbody>{[...state.ledger].reverse().map(entry => <tr key={entry.id} className="border-b last:border-0"><td className="whitespace-nowrap p-3">{new Date(entry.created_at).toLocaleString()}</td><td className="p-3">{entry.reason.replaceAll('_', ' ')}</td><td className="p-3">{entry.email ?? '—'}</td><td className={`p-3 text-right tabular-nums ${entry.delta_cents < 0 ? 'text-destructive' : 'text-emerald-700'}`}>{entry.delta_cents > 0 ? '+' : ''}{formatMoney(entry.delta_cents)}</td><td className="p-3 text-right tabular-nums">{formatMoney(entry.resulting_balance_cents)}</td></tr>)}</tbody></table>{state.ledger.length === 0 && <p className="p-8 text-center text-sm text-muted-foreground">No drawer activity yet.</p>}</div></CardContent></Card>
        {state.pending.length > 0 && <Card><CardHeader><div className="flex items-center justify-between gap-3"><CardTitle>Invoice upload queue</CardTitle><Button size="sm" variant="outline" disabled={!online || !user} onClick={() => void tryUpload(state)}>Retry uploads</Button></div></CardHeader><CardContent><ul className="space-y-2">{state.pending.map(item => <li key={item.snapshot.cart_uuid} className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3 text-sm"><span><span className="font-mono">{item.snapshot.cart_uuid.slice(0, 8)}</span><span className="ml-3">{item.status === 'blocked' ? 'Blocked' : 'Waiting to upload'}</span>{item.message && <span className="ml-2 text-destructive">{item.message}</span>}</span><span>{formatMoney(item.snapshot.chargeable_total_cents)} chargeable</span></li>)}</ul></CardContent></Card>}
      </section>}
    </main>
    <footer className="mx-auto flex max-w-[1760px] items-center justify-between px-4 pb-6 text-xs text-muted-foreground lg:px-6">{view !== 'checkout' && <span>{status}</span>}<span className="inline-flex items-center gap-1">{online ? <Cloud size={13}/> : <CloudOff size={13}/>} {online ? 'Connection available' : 'Working offline'}</span></footer>

    <Dialog open={dialogMode !== null} onOpenChange={open => { if (!open) setDialogMode(null); }} title={dialogTitle}>
      <form onSubmit={submitAmount} className="space-y-4">
        <label htmlFor="dialog-amount" className="block text-sm text-muted-foreground">{dialogMode === 'manual-set' ? 'New signed drawer balance' : dialogMode === 'manual-subtract' ? 'Amount to subtract' : 'Amount in EUR'}</label>
        <Input id="dialog-amount" autoFocus inputMode="decimal" placeholder={dialogMode === 'manual-set' ? '-2,50' : '2,50'} value={dialogAmount} onChange={event => { setDialogAmount(event.target.value); setDialogError(''); }}/>
        {dialogError && <p role="alert" className="text-sm text-destructive">{dialogError}</p>}
        <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => setDialogMode(null)}>Cancel</Button><Button type="submit">Confirm</Button></div>
      </form>
    </Dialog>
  </div>;
}

function parseSignedCurrency(value: string): number | null {
  const normalized = value.trim().replace(/[−]/g, '-');
  const negative = normalized.startsWith('-');
  const amount = parseCurrencyToCents(negative ? normalized.slice(1) : normalized, true);
  if (amount === null) return null;
  const signed = negative ? -amount : amount;
  return Number.isSafeInteger(signed) ? signed : null;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
