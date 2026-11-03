const guestCartKey = 'stefbykurd-cart-guest';
const legacyCartKey = 'stefbykurd-cart';
const rememberedEmailKey = 'stefbykurd-remembered-email';
const activeUserStorageKey = 'stefbykurd-active-user';
const previewFavoritesKey = 'stefbykurd-preview-favorites';
const isStaticPreview = window.location.hostname.endsWith('github.io');
const previewProducts = [
  {
    id: '00000000-0000-4000-8000-000000000001',
    name: 'Bolso tote floral',
    category: 'Estampados',
    description: 'Un toque de color para tus dias. Reutilizable, amplio y lleno de flores.',
    image: 'assets/floral-tote.jpg',
    priceCents: 189000,
    stock: 24,
    featured: 1,
    colors: [],
    images: []
  },
  {
    id: '00000000-0000-4000-8000-000000000002',
    name: 'Tote geometrico',
    category: 'Estampados',
    description: 'Diseno geometrico en tonos naturales, ligero y listo para acompanarte.',
    image: 'assets/geometric-tote.jpg',
    priceCents: 169000,
    stock: 18,
    featured: 1,
    colors: [],
    images: []
  },
  {
    id: '00000000-0000-4000-8000-000000000003',
    name: 'Bolso negro esencial',
    category: 'Clasicos',
    description: 'Minimalista y versatil. Tu bolso de todos los dias, hecho para durar.',
    image: 'assets/black-tote.jpg',
    priceCents: 149000,
    stock: 32,
    featured: 1,
    colors: [],
    images: []
  },
  {
    id: '00000000-0000-4000-8000-000000000004',
    name: 'Tote natural',
    category: 'Clasicos',
    description: 'Un basico atemporal en color natural, comodo y reutilizable.',
    image: 'assets/natural-tote.jpg',
    priceCents: 129000,
    stock: 27,
    featured: 0,
    colors: [],
    images: []
  },
  {
    id: '00000000-0000-4000-8000-000000000005',
    name: 'Bolso tote botanico',
    category: 'Estampados',
    description: 'Inspirado en la naturaleza, con un estampado botanico delicado.',
    image: 'assets/botanical-tote.jpg',
    priceCents: 199000,
    stock: 14,
    featured: 1,
    colors: [],
    images: []
  },
  {
    id: '00000000-0000-4000-8000-000000000006',
    name: 'Tote azul marino',
    category: 'Clasicos',
    description: 'Color profundo y silueta comoda para tus compras y salidas.',
    image: 'assets/navy-tote.jpg',
    priceCents: 159000,
    stock: 20,
    featured: 0,
    colors: [],
    images: []
  },
  {
    id: '00000000-0000-4000-8000-000000000007',
    name: 'Bolso tote de flores',
    category: 'Estampados',
    description: 'Un estampado alegre que transforma cualquier paseo.',
    image: 'assets/flower-tote.jpg',
    priceCents: 189000,
    stock: 16,
    featured: 0,
    colors: [],
    images: []
  },
  {
    id: '00000000-0000-4000-8000-000000000008',
    name: 'Bolso rojo granate',
    category: 'Clasicos',
    description: 'Una pieza practica con un color que no pasa desapercibido.',
    image: 'assets/burgundy-tote.jpg',
    priceCents: 159000,
    stock: 12,
    featured: 0,
    colors: [],
    images: []
  }
];
const state = {
  user: null,
  products: [],
  productCache: new Map(),
  categories: [],
  category: '',
  query: '',
  guestCart: loadCart(guestCartKey),
  cart: [],
  favorites: [],
  favoriteIds: new Set(),
  cartSyncQueue: Promise.resolve(),
  authMode: 'login',
  transactionOffset: 0,
  auditOffset: 0,
  cartOffset: 0,
  pendingEmail: '',
  verificationToken: '',
  detailProductId: '',
  detailImageIndex: 0,
  editingMainImage: '',
  editingProductImages: [],
  imagePreviewUrls: [],
  toastTimer: null
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const currency = new Intl.NumberFormat('es-AR', {
  style: 'currency',
  currency: 'ARS',
  maximumFractionDigits: 0
});

function money(cents) {
  return currency.format((Number(cents) || 0) / 100);
}

function syncActiveUser() {
  try {
    if (state.user) localStorage.setItem(activeUserStorageKey, state.user.id);
    else localStorage.removeItem(activeUserStorageKey);
  } catch {
    showToast('No se pudo sincronizar la cuenta entre pestanas.');
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);
}

async function api(url, options = {}) {
  const isFormData = options.body instanceof FormData;
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers: {
      ...(state.user?.role === 'buyer' ? { 'X-Buyer-Id': state.user.id } : {}),
      ...(options.body && !isFormData ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers
    }
  });
  if (response.status === 204) {
    if (!response.ok) throw new Error('No fue posible completar la solicitud.');
    return null;
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || 'No fue posible completar la solicitud.');
    error.code = data.code;
    throw error;
  }
  return data;
}

function loadCart(key = guestCartKey) {
  try {
    let raw = localStorage.getItem(key);
    if (key === guestCartKey) localStorage.removeItem(legacyCartKey);
    const stored = JSON.parse(raw || '[]');
    if (!Array.isArray(stored)) return [];
    return stored.filter((item) =>
      item && typeof item.id === 'string' && Number.isInteger(item.quantity) &&
      item.quantity > 0 && item.quantity <= 50
    );
  } catch {
    return [];
  }
}

function activeCartStorageKey() {
  return state.user?.role === 'buyer'
    ? `stefbykurd-cart-${state.user.id}`
    : guestCartKey;
}

function persistCart({ sync = true } = {}) {
  const ownerId = state.user?.role === 'buyer' ? state.user.id : null;
  const snapshot = state.cart.map((item) => ({ ...item }));
  try {
    localStorage.setItem(activeCartStorageKey(), JSON.stringify(snapshot));
    if (!ownerId) state.guestCart = snapshot;
  } catch {
    showToast('No se pudo guardar la bolsa en este dispositivo.');
  }
  updateCartCount();
  if (!sync || !ownerId) return Promise.resolve();
  const synchronize = state.cartSyncQueue.catch(() => {}).then(async () => {
    if (state.user?.id !== ownerId || state.user?.role !== 'buyer') return;
    await api('/api/cart/mine', {
      method: 'PUT',
      body: JSON.stringify({
        items: snapshot.map(({ id, quantity }) => ({ productId: id, quantity }))
      })
    });
  });
  state.cartSyncQueue = synchronize.catch((error) => {
    if (state.user?.id === ownerId) showToast(`No se pudo guardar tu bolsa: ${error.message}`);
  });
  return state.cartSyncQueue;
}

function getRememberedEmail() {
  try {
    return localStorage.getItem(rememberedEmailKey) || '';
  } catch {
    return '';
  }
}

function updateRememberedEmail(email) {
  try {
    if (email) localStorage.setItem(rememberedEmailKey, email);
    else localStorage.removeItem(rememberedEmailKey);
    return true;
  } catch {
    return false;
  }
}

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.remove('visible'), 3000);
}

function showModal(id) {
  closeOverlays();
  const modal = document.getElementById(id);
  if (!modal) return;
  $('#overlay').hidden = false;
  requestAnimationFrame(() => $('#overlay').classList.add('visible'));
  modal.hidden = false;
  document.body.classList.add('modal-open');
  requestAnimationFrame(() => modal.classList.add('open'));
}

function closeOverlays() {
  $$('.modal').forEach((modal) => {
    modal.classList.remove('open');
    modal.hidden = true;
  });
  const drawer = $('#cart-drawer');
  drawer.classList.remove('open');
  drawer.setAttribute('aria-hidden', 'true');
  $('#overlay').classList.remove('visible');
  $('#overlay').hidden = true;
  document.body.classList.remove('modal-open');
}

function openCart() {
  closeOverlays();
  renderCart();
  $('#overlay').hidden = false;
  requestAnimationFrame(() => $('#overlay').classList.add('visible'));
  $('#cart-drawer').classList.add('open');
  $('#cart-drawer').setAttribute('aria-hidden', 'false');
  document.body.classList.add('modal-open');
}

async function fetchProducts() {
  if (isStaticPreview) {
    const query = state.query.toLocaleLowerCase('es');
    state.products = previewProducts.filter((product) =>
      (!state.category || product.category === state.category) &&
      (!query || `${product.name} ${product.category} ${product.description}`
        .toLocaleLowerCase('es').includes(query))
    );
    state.categories = [...new Set(previewProducts.map((product) => product.category))];
    for (const product of state.products) state.productCache.set(product.id, product);
    renderCategories();
    renderProducts();
    renderCart();
    return;
  }
  const params = new URLSearchParams();
  if (state.query) params.set('q', state.query);
  if (state.category) params.set('category', state.category);
  try {
    const data = await api(`/api/products?${params}`);
    state.products = data.products;
    for (const product of data.products) state.productCache.set(product.id, product);
    state.categories = data.categories;
    renderCategories();
    renderProducts();
    renderCart();
  } catch (error) {
    $('#products').innerHTML = `<p class="empty-results">${escapeHtml(error.message)} Recarga la pagina para intentarlo de nuevo.</p>`;
  }
}

function renderCategories() {
  const values = ['', ...state.categories];
  $('#category-pills').innerHTML = values.map((category) => `
    <button class="category-pill${category === state.category ? ' active' : ''}"
      data-category="${escapeHtml(category)}">${category ? escapeHtml(category) : 'Todos los bolsos'}</button>
  `).join('');
}

function renderProducts() {
  if (state.products.length === 0) {
    $('#products').innerHTML = '<p class="empty-results">No encontramos productos con esos filtros.</p>';
    return;
  }
  $('#products').innerHTML = state.products.map((product) => {
    const soldOut = product.stock <= 0;
    return `
      <article class="product-card">
        <div class="product-image-wrap">
          <img class="product-image" src="${escapeHtml(product.image)}" alt="${escapeHtml(product.name)}" loading="lazy">
          <span class="product-badge${soldOut ? ' sold-out' : ''}">${soldOut ? 'AGOTADO' : 'DISPONIBLE'}</span>
          <button class="favorite-toggle${state.favoriteIds.has(product.id) ? ' active' : ''}" data-action="favorite-toggle" data-id="${escapeHtml(product.id)}"
            aria-label="${state.favoriteIds.has(product.id) ? 'Quitar de favoritos' : 'Agregar a favoritos'}" aria-pressed="${state.favoriteIds.has(product.id)}">${state.favoriteIds.has(product.id) ? '♥' : '♡'}</button>
          <button class="add-product" data-action="add" data-id="${escapeHtml(product.id)}"
            aria-label="Agregar ${escapeHtml(product.name)} a la bolsa" ${soldOut ? 'disabled' : ''}>+</button>
        </div>
        <div class="product-meta">
          <div><h3>${escapeHtml(product.name)}</h3><p class="product-category">${escapeHtml(product.category)} · ${soldOut ? 'Sin stock' : `${product.stock} disponibles`}</p></div>
          <span class="product-price">${money(product.priceCents)}</span>
        </div>
          <button class="product-details-button" data-action="details" data-id="${escapeHtml(product.id)}">Ver mas detalles</button>
        </article>
    `;
  }).join('');
}

function productImages(product) {
  return [...new Set([product.image, ...(product.images || [])].filter(Boolean))];
}

function renderProductDetails(product) {
  if (!product) return;
  const images = productImages(product);
  state.detailImageIndex = Math.min(state.detailImageIndex, Math.max(images.length - 1, 0));
  $('#product-detail-category').textContent = product.category;
  $('#product-detail-title').textContent = product.name;
  $('#product-detail-price').textContent = money(product.priceCents);
  $('#product-detail-description').textContent = product.description;
  $('#product-detail-image').src = images[state.detailImageIndex] || product.image;
  $('#product-detail-image').alt = product.name;
  $('#product-detail-thumbnails').innerHTML = images.length > 1 ? images.map((image, index) => `
    <button class="product-detail-thumbnail${index === state.detailImageIndex ? ' active' : ''}"
      type="button" data-action="detail-image" data-index="${index}" aria-label="Ver foto ${index + 1}">
      <img src="${escapeHtml(image)}" alt="">
    </button>
  `).join('') : '';
  const dimensions = [
    product.heightCm && `Alto: ${product.heightCm} cm`,
    product.widthCm && `Ancho: ${product.widthCm} cm`,
    product.depthCm && `Profundidad: ${product.depthCm} cm`
  ].filter(Boolean);
  const specs = [
    ['Tamaño', dimensions.length ? dimensions.join(' · ') : 'No especificado'],
    ['Colores', product.colors?.length ? product.colors.join(', ') : 'No especificados'],
    ['Diseño', product.design || 'No especificado'],
    ['Disponibilidad', product.stock > 0 ? `${product.stock} disponibles` : 'Agotado']
  ];
  $('#product-detail-specs').innerHTML = specs.map(([label, value]) => `
    <div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>
  `).join('');
  const addButton = $('#product-detail-add');
  addButton.disabled = product.stock < 1;
  addButton.textContent = product.stock > 0 ? 'Agregar a la bolsa →' : 'Agotado';
  const favoriteButton = $('#product-detail-favorite');
  favoriteButton.dataset.id = product.id;
  favoriteButton.classList.toggle('active', state.favoriteIds.has(product.id));
  favoriteButton.setAttribute('aria-pressed', String(state.favoriteIds.has(product.id)));
  favoriteButton.textContent = state.favoriteIds.has(product.id) ? '♥ En favoritos' : '♡ Agregar a favoritos';
}

function openProductDetails(productId) {
  const product = state.products.find((item) => item.id === productId);
  if (!product) return showToast('No encontramos este producto. Actualiza el catalogo e intenta de nuevo.');
  state.detailProductId = product.id;
  state.detailImageIndex = 0;
  renderProductDetails(product);
  showModal('product-detail-modal');
}

function updateCartCount() {
  const count = state.cart.reduce((total, item) => total + item.quantity, 0);
  $('#cart-count').textContent = String(count);
  $('#drawer-count').textContent = count ? `(${count})` : '';
}

function cartDetails() {
  return state.cart.map((item) => {
    const product = state.productCache.get(item.id) ||
      state.products.find((candidate) => candidate.id === item.id) ||
      state.favorites.find((candidate) => candidate.id === item.id);
    return product ? { ...product, quantity: Math.min(item.quantity, product.stock) } : null;
  }).filter((item) => item && item.quantity > 0);
}

function renderCart() {
  const details = cartDetails();
  const total = details.reduce((sum, item) => sum + item.priceCents * item.quantity, 0);
  $('#cart-items').innerHTML = details.map((item) => `
    <article class="cart-line">
      <img src="${escapeHtml(item.image)}" alt="${escapeHtml(item.name)}">
      <div>
        <h3>${escapeHtml(item.name)}</h3><span class="cart-line-price">${money(item.priceCents)}</span>
        <div class="quantity-control">
          <button data-action="decrease" data-id="${escapeHtml(item.id)}" aria-label="Restar uno">−</button>
          <span>${item.quantity}</span>
          <button data-action="increase" data-id="${escapeHtml(item.id)}" aria-label="Sumar uno" ${item.quantity >= item.stock ? 'disabled' : ''}>+</button>
        </div>
      </div>
      <button class="remove-item" data-action="remove" data-id="${escapeHtml(item.id)}" aria-label="Quitar ${escapeHtml(item.name)}">×</button>
    </article>
  `).join('');
  $('#cart-empty').hidden = details.length > 0;
  $('#cart-summary').hidden = details.length === 0;
  $('#cart-subtotal').textContent = money(total);
  updateCartCount();
}

function addToCart(productId) {
  const product = state.productCache.get(productId) ||
    state.products.find((item) => item.id === productId) ||
    state.favorites.find((item) => item.id === productId);
  if (!product || product.stock < 1) {
    showToast('Este producto ya no tiene stock.');
    return false;
  }
  const item = state.cart.find((candidate) => candidate.id === productId);
  if (item && item.quantity >= product.stock) {
    showToast('Ya agregaste todas las unidades disponibles.');
    return false;
  }
  if (item) item.quantity += 1;
  else state.cart.push({ id: productId, quantity: 1 });
  persistCart();
  renderCart();
  showToast('Agregado a tu bolsa.');
  return true;
}

function changeQuantity(productId, delta) {
  const item = state.cart.find((candidate) => candidate.id === productId);
  const product = state.productCache.get(productId) ||
    state.products.find((candidate) => candidate.id === productId) ||
    state.favorites.find((candidate) => candidate.id === productId);
  if (!item) return;
  item.quantity += delta;
  if (item.quantity <= 0) state.cart = state.cart.filter((candidate) => candidate.id !== productId);
  else if (product && item.quantity > product.stock) item.quantity = product.stock;
  persistCart();
  renderCart();
}

function setAuthMode(mode) {
  state.authMode = mode;
  const registering = mode === 'register';
  const passwordInput = $('#auth-form [name="password"]');
  const passwordToggle = $('[data-password-toggle]');
  const emailInput = $('#auth-form [name="email"]');
  const rememberedEmail = getRememberedEmail();
  $('#auth-form').hidden = false;
  $('#auth-success').hidden = true;
  $('#auth-note').hidden = false;
  $('.auth-tabs').hidden = false;
  $('#auth-name-wrap').hidden = !registering;
  $('#auth-name-wrap input').required = registering;
  $('#auth-remember-wrap').hidden = registering;
  if (!registering) {
    if (!emailInput.value && rememberedEmail) emailInput.value = rememberedEmail;
    $('#auth-remember').checked = Boolean(rememberedEmail && emailInput.value === rememberedEmail);
  }
  passwordInput.autocomplete = registering ? 'new-password' : 'current-password';
  passwordInput.type = 'password';
  passwordToggle.textContent = 'Ver';
  passwordToggle.setAttribute('aria-label', 'Mostrar contrasena');
  passwordToggle.setAttribute('aria-pressed', 'false');
  $('#auth-submit').innerHTML = registering ? 'Crear cuenta <span>→</span>' : 'Iniciar sesion <span>→</span>';
  $$('.auth-tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.authMode === mode));
  $('#auth-title').innerHTML = registering ? 'Crea tu espacio <em>Stefbykurd</em>' : 'Tu espacio <em>Stefbykurd</em>';
  $('#auth-message').textContent = '';
  $('#auth-message').classList.remove('success');
  $('#auth-resend').hidden = true;
}

function showRegistrationPending(email) {
  state.pendingEmail = email;
  $('#verification-email').textContent = email;
  $('#auth-title').innerHTML = 'Confirma tu <em>correo</em>';
  $('#auth-form').hidden = true;
  $('#auth-success').hidden = false;
  $('#auth-note').hidden = true;
  $('.auth-tabs').hidden = true;
  $('#auth-success-message').textContent = '';
}

async function resendVerification(email, target) {
  const message = $(target);
  message.textContent = '';
  message.classList.remove('success');
  try {
    const result = await api('/api/auth/resend-verification', {
      method: 'POST',
      body: JSON.stringify({ email })
    });
    message.textContent = result.message;
    message.classList.add('success');
  } catch (error) {
    message.textContent = error.message;
  }
}

function roleName(role) {
  return ({ buyer: 'Cliente', seller: 'Vendedor', manager: 'Gerente', owner: 'Dueño' })[role] || role;
}

function renderPurchasedItem(item) {
  const dimensions = [
    item.heightCm && `Alto ${item.heightCm} cm`,
    item.widthCm && `ancho ${item.widthCm} cm`,
    item.depthCm && `profundidad ${item.depthCm} cm`
  ].filter(Boolean);
  const photos = [...new Set([item.image, ...(item.images || [])].filter(Boolean))];
  return `
    <article class="purchased-item">
      <img class="purchased-item-image" src="${escapeHtml(item.image || '/assets/black-tote.jpg')}" alt="${escapeHtml(item.name)}">
      <div class="purchased-item-details">
        <h4>${escapeHtml(item.name)} <span>× ${item.quantity}</span></h4>
        <p>${escapeHtml(item.category || 'Producto')} · ${money(item.unitPriceCents)} c/u</p>
        ${item.description ? `<p>${escapeHtml(item.description)}</p>` : ''}
        <dl>
          <div><dt>Tamaño</dt><dd>${escapeHtml(dimensions.length ? dimensions.join(', ') : 'No especificado')}</dd></div>
          <div><dt>Colores</dt><dd>${escapeHtml(item.colors?.length ? item.colors.join(', ') : 'No especificados')}</dd></div>
          <div><dt>Diseño</dt><dd>${escapeHtml(item.design || 'No especificado')}</dd></div>
        </dl>
        ${photos.length > 1 ? `<div class="purchased-item-gallery">${photos.map((photo) => `
          <img src="${escapeHtml(photo)}" alt="Foto de ${escapeHtml(item.name)}" loading="lazy">
        `).join('')}</div>` : ''}
      </div>
      <strong class="purchased-item-total">${money(item.lineTotalCents)}</strong>
    </article>
  `;
}

function renderFavorites(favorites) {
  const container = $('#account-favorites');
  container.innerHTML = favorites.length ? favorites.map((product) => `
    <article class="favorite-item">
      <img src="${escapeHtml(product.image)}" alt="${escapeHtml(product.name)}">
      <div class="favorite-item-details">
        <h4>${escapeHtml(product.name)}</h4>
        <p>${escapeHtml(product.category)} · ${money(product.priceCents)}</p>
        <small>${product.stock > 0 ? `${product.stock} disponibles` : 'Sin stock'}</small>
        <div class="favorite-item-actions">
          <button class="text-link" data-action="buy-favorite" data-id="${escapeHtml(product.id)}" ${product.stock < 1 ? 'disabled' : ''}>Agregar a mi bolsa <span>→</span></button>
          <button class="table-action danger" data-action="remove-favorite" data-id="${escapeHtml(product.id)}">Quitar</button>
        </div>
      </div>
    </article>
  `).join('') : '<p class="auth-note">Todavia no guardaste favoritos. Pulsa el corazon en un producto para encontrarlo aqui.</p>';
}

async function loadBuyerData() {
  const ownerId = state.user.id;
  try {
    const [cartData, favoritesData] = await Promise.all([
      api('/api/cart/mine'),
      api('/api/favorites/mine')
    ]);
    if (state.user?.id !== ownerId) return;
    state.favorites = favoritesData.favorites;
    state.favoriteIds = new Set(state.favorites.map((product) => product.id));
    for (const product of state.favorites) state.productCache.set(product.id, product);
    state.cart = cartData.items
      .filter((product) => product.active && product.stock > 0)
      .map((product) => {
        state.productCache.set(product.id, product);
        return { id: product.id, quantity: Math.min(product.quantity, product.stock) };
      });
    await persistCart();
    renderProducts();
    renderCart();
  } catch (error) {
    if (state.user?.id !== ownerId) return;
    state.cart = loadCart(activeCartStorageKey());
    state.favorites = [];
    state.favoriteIds.clear();
    renderProducts();
    renderCart();
    showToast(`No se pudo sincronizar tu bolsa y favoritos: ${error.message}`);
  }
}

async function toggleFavorite(productId) {
  if (isStaticPreview) {
    const isFavorite = state.favoriteIds.has(productId);
    if (isFavorite) {
      state.favoriteIds.delete(productId);
      state.favorites = state.favorites.filter((product) => product.id !== productId);
    } else {
      const product = state.productCache.get(productId) ||
        previewProducts.find((item) => item.id === productId);
      if (!product) return;
      state.favoriteIds.add(productId);
      state.favorites = [product, ...state.favorites.filter((item) => item.id !== productId)];
    }
    try {
      localStorage.setItem(previewFavoritesKey, JSON.stringify([...state.favoriteIds]));
    } catch {
      showToast('No se pudieron guardar tus favoritos en este navegador.');
    }
    renderProducts();
    const product = state.productCache.get(productId);
    if (product && state.detailProductId === productId) renderProductDetails(product);
    showToast(isFavorite ? 'Producto quitado de favoritos.' : 'Producto guardado en favoritos.');
    return;
  }
  if (state.user && state.user.role !== 'buyer') {
    showToast('Los favoritos estan disponibles para cuentas de cliente.');
    return;
  }
  if (!state.user) {
    setAuthMode('login');
    showModal('auth-modal');
    $('#auth-message').textContent = 'Inicia sesion como cliente para guardar tus favoritos.';
    return;
  }
  const isFavorite = state.favoriteIds.has(productId);
  try {
    await api(`/api/favorites/${encodeURIComponent(productId)}`, {
      method: isFavorite ? 'DELETE' : 'POST'
    });
    if (isFavorite) {
      state.favoriteIds.delete(productId);
      state.favorites = state.favorites.filter((product) => product.id !== productId);
    } else {
      const product = state.productCache.get(productId) ||
        state.products.find((item) => item.id === productId);
      if (product) {
        state.favoriteIds.add(productId);
        state.favorites = [product, ...state.favorites.filter((item) => item.id !== productId)];
      }
    }
    renderProducts();
    const product = state.productCache.get(productId);
    if (product && state.detailProductId === productId) renderProductDetails(product);
    renderFavorites(state.favorites);
    showToast(isFavorite ? 'Producto quitado de favoritos.' : 'Producto guardado en favoritos.');
  } catch (error) {
    showToast(error.message);
  }
}

async function openAccount() {
  if (isStaticPreview) {
    showToast('Vista previa: el acceso a cuentas no esta habilitado.');
    return;
  }
  if (!state.user) {
    setAuthMode('login');
    showModal('auth-modal');
    return;
  }
  $('#account-name').textContent = state.user.name;
  $('#account-role').textContent = roleName(state.user.role);
  const canManage = ['seller', 'manager', 'owner'].includes(state.user.role);
  $('#dashboard-button').hidden = !canManage;
  const orders = $('#account-orders');
  $('#account-favorites-section').hidden = state.user.role !== 'buyer';
  if (state.user.role !== 'buyer') {
    $('#account-favorites').innerHTML = '';
    orders.innerHTML = '<p class="auth-note">Tu panel de equipo te permite gestionar el inventario y consultar las herramientas habilitadas para tu rol.</p>';
  } else {
    orders.innerHTML = '<h3>Mis compras</h3><p class="auth-note">Cargando tus pedidos...</p>';
    $('#account-favorites').innerHTML = '<p class="auth-note">Cargando tus favoritos...</p>';
    try {
      const [{ transactions }, { favorites }] = await Promise.all([
        api('/api/transactions/mine'),
        api('/api/favorites/mine')
      ]);
      state.favorites = favorites;
      state.favoriteIds = new Set(favorites.map((product) => product.id));
      for (const product of favorites) state.productCache.set(product.id, product);
      renderProducts();
      renderFavorites(favorites);
      orders.innerHTML = `<h3>Mis compras</h3>${transactions.length
        ? transactions.map((order) => `
          <section class="account-order-card">
            <div class="account-order"><span>Pedido #${escapeHtml(order.id.slice(0, 8))}<small>${new Date(`${order.createdAt}Z`).toLocaleDateString('es-AR')}</small></span><strong>${money(order.totalCents)}</strong></div>
            ${(order.items || []).map(renderPurchasedItem).join('')}
          </section>
        `).join('')
        : '<p class="auth-note">Todavia no tienes compras. Tu proximo favorito te espera en la tienda.</p>'}`;
    } catch (error) {
      orders.innerHTML = `<p class="form-message">${escapeHtml(error.message)}</p>`;
      $('#account-favorites').innerHTML = `<p class="form-message">${escapeHtml(error.message)}</p>`;
    }
  }
  showModal('account-modal');
}

async function handleAuthSubmit(event) {
  event.preventDefault();
  if (isStaticPreview) {
    $('#auth-message').textContent = 'El acceso a cuentas no esta habilitado en esta vista previa.';
    return;
  }
  const form = event.currentTarget;
  const button = $('#auth-submit');
  button.disabled = true;
  $('#auth-message').textContent = '';
  const body = Object.fromEntries(new FormData(form));
  try {
    const endpoint = state.authMode === 'register' ? '/api/auth/register' : '/api/auth/login';
    if (state.authMode === 'login') body.rememberMe = $('#auth-remember').checked;
    const result = await api(endpoint, { method: 'POST', body: JSON.stringify(body) });
    if (state.authMode === 'register') {
      form.reset();
      showRegistrationPending(body.email.trim().toLowerCase());
      return;
    }
    const rememberEmail = $('#auth-remember').checked;
    if (!updateRememberedEmail(rememberEmail ? body.email.trim().toLowerCase() : '')) {
      showToast('No se pudo guardar la preferencia en este navegador.');
    }
    const { user } = result;
    state.user = user;
    syncActiveUser();
    state.cartSyncQueue = Promise.resolve();
    if (user.role === 'buyer') await loadBuyerData();
    else {
      state.cart = state.guestCart.map((item) => ({ ...item }));
      state.favorites = [];
      state.favoriteIds.clear();
    }
    closeOverlays();
    form.reset();
    syncAccountButton();
    showToast(`Hola, ${user.name}. Que bueno tenerte aqui.`);
    if (['seller', 'manager', 'owner'].includes(user.role)) await openDashboard();
  } catch (error) {
    $('#auth-message').textContent = error.message;
    if (error.code === 'EMAIL_NOT_VERIFIED') {
      state.pendingEmail = body.email.trim().toLowerCase();
      $('#auth-resend').hidden = false;
    }
  } finally {
    button.disabled = false;
  }
}

async function verifyEmail() {
  const button = $('#confirm-email');
  button.disabled = true;
  $('#verify-message').classList.remove('success');
  $('#verify-message').textContent = '';
  try {
    await api('/api/auth/verify-email', {
      method: 'POST',
      body: JSON.stringify({ token: state.verificationToken })
    });
    state.verificationToken = '';
    $('#verify-message').textContent = 'Correo confirmado. Ya puedes iniciar sesion.';
    $('#verify-message').classList.add('success');
    $('#confirm-email').innerHTML = 'Correo confirmado ✓';
    const cleanUrl = new URL(window.location.href);
    cleanUrl.searchParams.delete('verify');
    window.history.replaceState(null, '', `${cleanUrl.pathname}${cleanUrl.search}${cleanUrl.hash}`);
    closeOverlays();
    setAuthMode('login');
    showModal('auth-modal');
    $('#auth-message').textContent = 'Correo confirmado. Ya puedes iniciar sesion.';
    $('#auth-message').classList.add('success');
  } catch (error) {
    $('#verify-message').textContent = error.message;
    $('#verify-resend-form').hidden = !['EMAIL_VERIFICATION_EXPIRED', 'EMAIL_TOKEN_INVALID'].includes(error.code);
    button.disabled = false;
  }
}

async function handleExpiredLinkResend(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const email = form.elements.email.value.trim().toLowerCase();
  const button = form.querySelector('button');
  button.disabled = true;
  try {
    const { message } = await api('/api/auth/resend-verification', {
      method: 'POST',
      body: JSON.stringify({ email })
    });
    $('#verify-message').textContent = message;
    $('#verify-message').classList.add('success');
    $('#verify-resend-form').hidden = true;
  } catch (error) {
    $('#verify-message').textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

function openVerificationLink() {
  const url = new URL(window.location.href);
  const token = url.searchParams.get('verify');
  if (!token) return;
  state.verificationToken = token;
  url.searchParams.delete('verify');
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  showModal('verify-modal');
}

function syncAccountButton() {
  $('#account-label').textContent = state.user ? 'Mi espacio' : 'Mi cuenta';
  $('#account-button').setAttribute('aria-label', state.user ? 'Abrir mi espacio' : 'Iniciar sesion');
}

function setStoreVisible(visible) {
  $$('.store-page').forEach((section) => { section.hidden = !visible; });
  $('#dashboard').hidden = visible;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function renderStats(summary) {
  const stats = summary
    ? [
      ['Productos activos', summary.activeProducts],
      ['Vendedores activos', summary.activeSellers],
      ['Transacciones', summary.transactions],
      ['Ventas simuladas', money(summary.revenueCents)]
    ]
    : [['Tus productos', state.products.length], ['Tu rol', roleName(state.user.role)]];
  $('#dashboard-stats').innerHTML = stats.map(([label, value]) => `
    <div class="stat-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>
  `).join('');
}

function renderInventory(products) {
  $('#inventory-body').innerHTML = products.length ? products.map((product) => `
    <tr>
      <td><div class="table-product"><img src="${escapeHtml(product.image)}" alt=""><span>${escapeHtml(product.name)}</span></div></td>
      <td>${escapeHtml(product.category)}</td><td>${money(product.priceCents)}</td>
      <td>${product.stock}</td><td><span class="status-pill${!product.active ? ' suspended' : product.stock === 0 ? ' out' : ''}">${!product.active ? 'Archivado' : product.stock === 0 ? 'Sin stock' : 'Activo'}</span></td>
      <td>${product.active ? `<button class="table-action" data-action="edit-product" data-id="${escapeHtml(product.id)}">Editar</button>${state.user.role !== 'seller' || product.sellerId === state.user.id ? `<button class="table-action danger" data-action="delete-product" data-id="${escapeHtml(product.id)}">Eliminar</button>` : ''}` : '—'}</td>
    </tr>
  `).join('') : '<tr><td class="empty-row" colspan="6">Todavia no hay productos para mostrar.</td></tr>';
}

function clearProductImagePreviews() {
  state.imagePreviewUrls.forEach((url) => URL.revokeObjectURL(url));
  state.imagePreviewUrls = [];
}

function renderProductImagePreviews() {
  clearProductImagePreviews();
  const mainFile = $('#product-main-file').files[0];
  const mainImage = mainFile ? URL.createObjectURL(mainFile) : state.editingMainImage;
  if (mainFile) state.imagePreviewUrls.push(mainImage);
  $('#product-main-preview').innerHTML = mainImage
    ? `<div class="product-image-preview"><img src="${escapeHtml(mainImage)}" alt="Vista previa de foto principal"><button type="button" class="table-action danger" data-action="remove-main-image">Quitar foto</button></div>`
    : '<p class="product-upload-hint">Selecciona una foto principal para este producto.</p>';

  const selectedFiles = [...$('#product-extra-files').files];
  const selectedPreviews = selectedFiles.map((file) => {
    const url = URL.createObjectURL(file);
    state.imagePreviewUrls.push(url);
    return `<div class="product-image-preview"><img src="${escapeHtml(url)}" alt="Vista previa de ${escapeHtml(file.name)}"><span>${escapeHtml(file.name)}</span></div>`;
  });
  const savedPreviews = state.editingProductImages.map((image, index) => `
    <div class="product-image-preview">
      <img src="${escapeHtml(image)}" alt="Foto adicional ${index + 1}">
      <button type="button" class="table-action danger" data-action="remove-extra-image" data-index="${index}">Quitar foto</button>
    </div>
  `);
  $('#product-existing-images').innerHTML = savedPreviews.length
    ? `<div class="product-image-previews">${savedPreviews.join('')}</div>`
    : '';
  $('#product-upload-preview').innerHTML = selectedPreviews.join('');
}

async function openDashboard() {
  if (!state.user || !['seller', 'manager', 'owner'].includes(state.user.role)) return;
  setStoreVisible(false);
  $('#dashboard-welcome').textContent = `Sesión iniciada como ${state.user.name} · ${roleName(state.user.role)}`;
  const isManager = ['manager', 'owner'].includes(state.user.role);
  $$('.seller-only').forEach((section) => { section.hidden = state.user.role !== 'seller'; });
  $$('.manager-only').forEach((section) => { section.hidden = !isManager; });
  $('#manager-option').hidden = state.user.role !== 'owner';
  try {
    const { products } = await api('/api/seller/products');
    renderInventory(products);
    if (isManager) {
      const [summaryData, usersData] = await Promise.all([
        api('/api/admin/summary'),
        api('/api/admin/users')
      ]);
      renderStats(summaryData.summary);
      renderUsers(usersData.users);
      await Promise.all([loadTransactions(0), loadAudit(0), loadCustomerCarts(0)]);
    } else {
      renderStats(null);
      const { logs } = await api('/api/seller/audit');
      renderAudit(logs, '#seller-audit-body');
    }
  } catch (error) {
    showToast(error.message);
  }
}

function renderUsers(users) {
  $('#users-body').innerHTML = users.length ? users.map((user) => `
    <tr>
      <td>${escapeHtml(user.name)}</td><td>${escapeHtml(user.email)}</td><td>${escapeHtml(roleName(user.role))}</td>
      <td><span class="status-pill${user.status === 'suspended' ? ' suspended' : ''}">${user.status === 'active' ? 'Activo' : 'Suspendido'}</span></td>
      <td>
        ${user.role === 'seller' && user.status === 'active' ? `<button class="table-action" data-action="reset-seller-password" data-id="${escapeHtml(user.id)}" data-name="${escapeHtml(user.name)}">Cambiar clave</button>` : ''}
        <button class="table-action" data-action="toggle-user" data-id="${escapeHtml(user.id)}" data-status="${user.status === 'active' ? 'suspended' : 'active'}">${user.status === 'active' ? 'Suspender' : 'Reactivar'}</button>
        <button class="table-action danger" data-action="delete-user" data-id="${escapeHtml(user.id)}">Eliminar</button>
      </td>
    </tr>
  `).join('') : '<tr><td class="empty-row" colspan="5">Todavia no hay cuentas de equipo o clientes.</td></tr>';
}

function renderTransactions(transactions) {
  $('#transactions-body').innerHTML = transactions.length ? transactions.map((item) => `
    <tr><td>#${escapeHtml(item.id.slice(0, 8))}</td><td>${escapeHtml(item.buyerName)}<br><small>${escapeHtml(item.buyerEmail)}</small></td>
      <td>${item.itemCount}</td><td>${money(item.totalCents)}</td>
      <td>${new Date(`${item.createdAt}Z`).toLocaleString('es-AR')}</td><td>Simulado</td></tr>
  `).join('') : '<tr><td class="empty-row" colspan="6">Aun no hay transacciones.</td></tr>';
}

function renderCustomerCarts(carts) {
  $('#customer-carts-body').innerHTML = carts.length ? carts.map((cart) => `
    <article class="customer-cart-card">
      <header><div><h3>${escapeHtml(cart.buyerName)}</h3><p>${escapeHtml(cart.buyerEmail)}</p></div>
        <strong>${cart.unitCount} unidades · ${money(cart.totalCents)}</strong></header>
      ${cart.items.length ? `<div class="customer-cart-items">${cart.items.map((item) => `
        <div class="customer-cart-item">
          <img src="${escapeHtml(item.image)}" alt="${escapeHtml(item.name)}">
          <div><strong>${escapeHtml(item.name)}</strong><small>${item.quantity} × ${money(item.priceCents)} · ${item.active ? (item.stock > 0 ? `${item.stock} disponibles` : 'Sin stock') : 'Archivado'}</small></div>
        </div>
      `).join('')}</div>` : '<p class="auth-note">La bolsa esta vacia.</p>'}
    </article>
  `).join('') : '<p class="auth-note">No hay bolsas de clientes con productos actualmente.</p>';
}

function renderAudit(logs, target = '#audit-body') {
  const actionLabels = {
    'product.created': 'Creo un producto',
    'product.updated': 'Edito un producto',
    'product.deleted': 'Elimino un producto',
    'user.seller.created': 'Creo un vendedor',
    'user.manager.created': 'Creo un gerente',
    'user.active': 'Reactivo una cuenta',
    'user.suspended': 'Suspendio una cuenta',
    'user.deleted': 'Elimino una cuenta'
  };
  $(target).innerHTML = logs.length ? logs.map((log) => `
    <tr><td>${new Date(`${log.createdAt}Z`).toLocaleString('es-AR')}</td>
      ${target === '#seller-audit-body' ? '' : `<td>${escapeHtml(log.actorName)}<br><small>${escapeHtml(roleName(log.actorRole))}</small></td>`}
      <td>${escapeHtml(actionLabels[log.action] || log.action)}</td>
      <td>${escapeHtml(log.entityType)}</td><td>${escapeHtml(log.details.name || log.details.email || '')}</td></tr>
  `).join('') : `<tr><td class="empty-row" colspan="${target === '#seller-audit-body' ? 4 : 5}">Todavia no se registraron acciones del equipo.</td></tr>`;
}

function renderPagination(target, pagination, action) {
  const { offset, limit, total, nextOffset } = pagination;
  const first = total ? offset + 1 : 0;
  const last = Math.min(offset + limit, total);
  $(target).innerHTML = `
    <span>${first}-${last} de ${total}</span>
    <button data-action="${action}" data-offset="${Math.max(0, offset - limit)}" ${offset === 0 ? 'disabled' : ''}>Anterior</button>
    <button data-action="${action}" data-offset="${nextOffset ?? offset}" ${nextOffset === null ? 'disabled' : ''}>Siguiente</button>
  `;
}

async function loadTransactions(offset) {
  const { transactions, pagination } = await api(`/api/admin/transactions?offset=${offset}`);
  state.transactionOffset = pagination.offset;
  renderTransactions(transactions);
  renderPagination('#transactions-pagination', pagination, 'transaction-page');
}

async function loadCustomerCarts(offset) {
  const { carts, pagination } = await api(`/api/admin/carts?offset=${offset}`);
  state.cartOffset = pagination.offset;
  renderCustomerCarts(carts);
  renderPagination('#customer-carts-pagination', pagination, 'customer-cart-page');
}

async function loadAudit(offset) {
  const { logs, pagination } = await api(`/api/admin/audit?offset=${offset}`);
  state.auditOffset = pagination.offset;
  renderAudit(logs);
  renderPagination('#audit-pagination', pagination, 'audit-page');
}

function fillProductForm(product) {
  const form = $('#product-form');
  clearProductImagePreviews();
  form.reset();
  form.elements.id.value = product?.id || '';
  form.elements.name.value = product?.name || '';
  form.elements.category.value = product?.category || '';
  form.elements.description.value = product?.description || '';
  state.editingMainImage = product?.image || '';
  state.editingProductImages = [...(product?.images || [])];
  form.elements.heightCm.value = product?.heightCm ?? '';
  form.elements.widthCm.value = product?.widthCm ?? '';
  form.elements.depthCm.value = product?.depthCm ?? '';
  form.elements.colors.value = product?.colors?.join(', ') || '';
  form.elements.design.value = product?.design || '';
  form.elements.price.value = product ? (product.priceCents / 100).toFixed(2) : '';
  form.elements.stock.value = product?.stock ?? '';
  $('#product-main-file').required = !state.editingMainImage;
  renderProductImagePreviews();
  $('#product-form-message').textContent = '';
  $('#save-product').textContent = product ? 'Guardar cambios' : 'Guardar producto';
  $('#product-form-wrap').hidden = false;
  $('#product-form-wrap').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function handleDashboardClick(event) {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const { action, id } = button.dataset;
  if (action === 'remove-main-image') {
    state.editingMainImage = '';
    $('#product-main-file').value = '';
    $('#product-main-file').required = true;
    return renderProductImagePreviews();
  }
  if (action === 'remove-extra-image') {
    state.editingProductImages.splice(Number(button.dataset.index), 1);
    return renderProductImagePreviews();
  }
  try {
    if (action === 'transaction-page') return await loadTransactions(Number(button.dataset.offset));
    if (action === 'audit-page') return await loadAudit(Number(button.dataset.offset));
    if (action === 'customer-cart-page') return await loadCustomerCarts(Number(button.dataset.offset));
    if (action === 'edit-product') {
      const { products } = await api('/api/seller/products');
      const product = products.find((item) => item.id === id);
      if (product) fillProductForm(product);
    }
    if (action === 'reset-seller-password') {
      const form = $('#user-password-form');
      form.reset();
      form.elements.userId.value = id;
      $('#user-password-description').textContent =
        `Define una nueva contrasena para ${button.dataset.name}. Podra ingresar desde «Mi cuenta» con su correo y esta clave.`;
      $('#user-password-message').textContent = '';
      $('#user-password-form-wrap').hidden = false;
      $('#user-password-form-wrap').scrollIntoView({ behavior: 'smooth', block: 'center' });
      form.elements.password.focus();
      return;
    }
    if (action === 'delete-product' && window.confirm('El producto dejara de aparecer en la tienda. ¿Continuar?')) {
      await api(`/api/seller/products/${encodeURIComponent(id)}`, { method: 'DELETE' });
      showToast('Producto archivado.');
      await openDashboard();
      await fetchProducts();
    }
    if (action === 'toggle-user') {
      await api(`/api/admin/users/${encodeURIComponent(id)}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: button.dataset.status })
      });
      showToast('Estado de cuenta actualizado.');
      await openDashboard();
    }
    if (action === 'delete-user' && window.confirm('¿Eliminar esta cuenta? Se conservara la informacion necesaria para el historial de compras.')) {
      await api(`/api/admin/users/${encodeURIComponent(id)}`, { method: 'DELETE' });
      showToast('Cuenta eliminada.');
      await openDashboard();
    }
  } catch (error) {
    showToast(error.message);
  }
}

async function handleProductSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $('#save-product');
  button.disabled = true;
  $('#product-form-message').textContent = '';
  const values = Object.fromEntries(new FormData(form));
  const productId = values.id;
  const mainFile = $('#product-main-file').files[0];
  const extraFiles = [...$('#product-extra-files').files];
  try {
    if (extraFiles.length > 10) throw new Error('Puedes agregar hasta 10 fotos adicionales.');
    if (!mainFile && !state.editingMainImage) throw new Error('Selecciona una foto principal.');
    let uploadedImages = [];
    if (mainFile || extraFiles.length) {
      const uploadForm = new FormData();
      if (mainFile) uploadForm.append('images', mainFile);
      extraFiles.forEach((file) => uploadForm.append('images', file));
      ({ images: uploadedImages } = await api('/api/seller/uploads', {
        method: 'POST',
        body: uploadForm
      }));
    }
    const body = JSON.stringify({
      name: values.name,
      category: values.category,
      description: values.description,
      image: mainFile ? uploadedImages[0] : state.editingMainImage,
      price: Number(values.price),
      stock: Number(values.stock),
      heightCm: values.heightCm ? Number(values.heightCm) : null,
      widthCm: values.widthCm ? Number(values.widthCm) : null,
      depthCm: values.depthCm ? Number(values.depthCm) : null,
      colors: values.colors.split(',').map((color) => color.trim()).filter(Boolean),
      design: values.design.trim(),
      images: [
        ...state.editingProductImages,
        ...uploadedImages.slice(mainFile ? 1 : 0)
      ]
    });
    await api(productId ? `/api/seller/products/${encodeURIComponent(productId)}` : '/api/seller/products', {
      method: productId ? 'PUT' : 'POST',
      body
    });
    $('#product-form-wrap').hidden = true;
    form.reset();
    state.editingMainImage = '';
    state.editingProductImages = [];
    clearProductImagePreviews();
    showToast(productId ? 'Producto actualizado.' : 'Producto creado.');
    await openDashboard();
    await fetchProducts();
  } catch (error) {
    $('#product-form-message').textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function handleUserSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  $('#user-form-message').textContent = '';
  const body = Object.fromEntries(new FormData(form));
  try {
    await api('/api/admin/users', { method: 'POST', body: JSON.stringify(body) });
    $('#user-form-wrap').hidden = true;
    form.reset();
    showToast(body.role === 'seller'
      ? 'Vendedor creado. Puede ingresar desde «Mi cuenta» con su correo y la contrasena inicial.'
      : 'Cuenta creada. Comparte las credenciales de forma segura.');
    await openDashboard();
  } catch (error) {
    $('#user-form-message').textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function handleUserPasswordSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  $('#user-password-message').textContent = '';
  const values = Object.fromEntries(new FormData(form));
  try {
    await api(`/api/admin/users/${encodeURIComponent(values.userId)}/password`, {
      method: 'PATCH',
      body: JSON.stringify({ password: values.password })
    });
    $('#user-password-form-wrap').hidden = true;
    form.reset();
    showToast('Contrasena actualizada. El vendedor ya puede ingresar desde «Mi cuenta».');
  } catch (error) {
    $('#user-password-message').textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

function renderCheckout() {
  const details = cartDetails();
  $('#checkout-lines').innerHTML = details.map((item) => `
    <div class="checkout-line"><span>${escapeHtml(item.name)} × ${item.quantity}</span><span>${money(item.priceCents * item.quantity)}</span></div>
  `).join('');
  $('#checkout-total').textContent = money(details.reduce((sum, item) => sum + item.priceCents * item.quantity, 0));
  $('#checkout-message').textContent = '';
}

async function confirmCheckout() {
  const button = $('#confirm-checkout');
  button.disabled = true;
  $('#checkout-message').textContent = '';
  try {
    await state.cartSyncQueue;
    const { transaction } = await api('/api/checkout', {
      method: 'POST',
      body: JSON.stringify({
        items: cartDetails().map((item) => ({ productId: item.id, quantity: item.quantity }))
      })
    });
    state.cart = [];
    await persistCart();
    closeOverlays();
    await fetchProducts();
    showToast(`Compra simulada confirmada. Pedido #${transaction.id.slice(0, 8)}.`);
  } catch (error) {
    $('#checkout-message').textContent = error.message;
    await fetchProducts();
  } finally {
    button.disabled = false;
  }
}

async function initialize() {
  $('#year').textContent = String(new Date().getFullYear());
  $('#dashboard').hidden = true;
  if (isStaticPreview) {
    $('#preview-note').hidden = false;
    try {
      const favorites = JSON.parse(localStorage.getItem(previewFavoritesKey) || '[]');
      if (Array.isArray(favorites)) state.favoriteIds = new Set(favorites);
    } catch {
      localStorage.removeItem(previewFavoritesKey);
    }
  }
  await fetchProducts();
  if (isStaticPreview) {
    state.cart = state.guestCart.map((item) => ({ ...item }));
    syncAccountButton();
    renderProducts();
    renderCart();
    persistCart({ sync: false });
    return;
  }
  try {
    const { user } = await api('/api/auth/me');
    state.user = user;
    syncActiveUser();
    if (user?.role === 'buyer') await loadBuyerData();
    else state.cart = state.guestCart.map((item) => ({ ...item }));
    syncAccountButton();
  } catch {
    state.user = null;
    syncActiveUser();
    state.cart = state.guestCart.map((item) => ({ ...item }));
  }
  renderProducts();
  renderCart();
  persistCart({ sync: false });
  openVerificationLink();
}

document.addEventListener('click', async (event) => {
  const passwordToggle = event.target.closest('[data-password-toggle]');
  if (passwordToggle) {
    const passwordInput = document.getElementById(passwordToggle.getAttribute('aria-controls'));
    const visible = passwordInput.type === 'password';
    passwordInput.type = visible ? 'text' : 'password';
    passwordToggle.textContent = visible ? 'Ocultar' : 'Ver';
    passwordToggle.setAttribute('aria-label', `${visible ? 'Ocultar' : 'Mostrar'} contrasena`);
    passwordToggle.setAttribute('aria-pressed', String(visible));
    return;
  }
  const closeButton = event.target.closest('[data-close]');
  if (closeButton) return closeOverlays();
  if (event.target.id === 'overlay') return closeOverlays();
  if (event.target.closest('#account-button')) return openAccount();
  if (event.target.closest('#cart-button')) return openCart();
  if (event.target.closest('#dashboard-button')) {
    closeOverlays();
    return openDashboard();
  }
  if (event.target.closest('#store-button')) {
    setStoreVisible(true);
    return;
  }
  if (event.target.closest('#logout-button')) {
    try {
      await state.cartSyncQueue;
      await api('/api/auth/logout', { method: 'POST' });
      state.user = null;
      syncActiveUser();
      state.cartSyncQueue = Promise.resolve();
      state.cart = state.guestCart.map((item) => ({ ...item }));
      state.favorites = [];
      state.favoriteIds.clear();
      renderProducts();
      renderCart();
      syncAccountButton();
      closeOverlays();
      setStoreVisible(true);
      showToast('Sesion cerrada.');
    } catch (error) {
      showToast(error.message);
    }
    return;
  }
  if (event.target.closest('#auth-resend')) {
    return resendVerification(state.pendingEmail, '#auth-message');
  }
  if (event.target.closest('#auth-success-resend')) {
    return resendVerification(state.pendingEmail, '#auth-success-message');
  }
  if (event.target.closest('[data-auth-reset]')) {
    setAuthMode('login');
    $('#auth-form [name="email"]').value = state.pendingEmail;
    return;
  }
  if (event.target.closest('#confirm-email')) return verifyEmail();
  if (event.target.closest('#checkout-button')) {
    if (!state.cart.length) return;
    if (isStaticPreview) {
      showToast('La compra no esta habilitada en esta vista previa.');
      return;
    }
    closeOverlays();
    if (!state.user) {
      setAuthMode('login');
      showModal('auth-modal');
      $('#auth-message').textContent = 'Inicia sesion o crea una cuenta para confirmar tu pedido.';
      return;
    }
    if (state.user.role !== 'buyer') {
      showToast('Las compras estan disponibles para cuentas de cliente.');
      return;
    }
    renderCheckout();
    showModal('checkout-modal');
    return;
  }
  if (event.target.closest('#clear-cart')) {
    state.cart = [];
    persistCart();
    renderCart();
    return;
  }
  if (event.target.closest('#new-product-button')) {
    fillProductForm(null);
    return;
  }
  if (event.target.closest('#cancel-product')) {
    $('#product-form-wrap').hidden = true;
    return;
  }
  if (event.target.closest('#new-user-button')) {
    $('#user-form').reset();
    $('#user-form-message').textContent = '';
    $('#user-form-wrap').hidden = false;
    return;
  }
  if (event.target.closest('#cancel-user')) {
    $('#user-form-wrap').hidden = true;
    return;
  }
  if (event.target.closest('#cancel-user-password')) {
    $('#user-password-form-wrap').hidden = true;
    $('#user-password-form').reset();
    return;
  }
  if (event.target.closest('#product-detail-add')) {
    closeOverlays();
    return addToCart(state.detailProductId);
  }
  const favoriteToggle = event.target.closest('[data-action="favorite-toggle"]');
  if (favoriteToggle) return toggleFavorite(favoriteToggle.dataset.id);
  const favoriteRemoval = event.target.closest('[data-action="remove-favorite"]');
  if (favoriteRemoval) return toggleFavorite(favoriteRemoval.dataset.id);
  const favoritePurchase = event.target.closest('[data-action="buy-favorite"]');
  if (favoritePurchase) {
    if (addToCart(favoritePurchase.dataset.id)) {
      closeOverlays();
      openCart();
    }
    return;
  }
  const detailImageButton = event.target.closest('[data-action="detail-image"]');
  if (detailImageButton) {
    state.detailImageIndex = Number(detailImageButton.dataset.index);
    return renderProductDetails(state.products.find((item) => item.id === state.detailProductId));
  }
  const detailButton = event.target.closest('[data-action="details"]');
  if (detailButton) return openProductDetails(detailButton.dataset.id);
  const categoryButton = event.target.closest('[data-category]');
  if (categoryButton) {
    state.category = categoryButton.dataset.category;
    return fetchProducts();
  }
  const authTab = event.target.closest('[data-auth-mode]');
  if (authTab) return setAuthMode(authTab.dataset.authMode);
  const cartAction = event.target.closest('#cart-items [data-action]');
  if (cartAction) {
    const { action, id } = cartAction.dataset;
    if (action === 'remove') {
      state.cart = state.cart.filter((item) => item.id !== id);
      persistCart();
      renderCart();
    } else {
      changeQuantity(id, action === 'increase' ? 1 : -1);
    }
    return;
  }
  const addButton = event.target.closest('#products [data-action="add"]');
  if (addButton) return addToCart(addButton.dataset.id);
});

window.addEventListener('storage', (event) => {
  if (event.key === activeUserStorageKey && event.newValue !== (state.user?.id || null)) {
    window.location.reload();
  }
});

$('#product-search').addEventListener('input', (event) => {
  clearTimeout(state.searchTimer);
  state.searchTimer = setTimeout(() => {
    state.query = event.target.value.trim();
    fetchProducts();
  }, 250);
});
$('#auth-form').addEventListener('submit', handleAuthSubmit);
$('#auth-remember').addEventListener('change', (event) => {
  if (!event.currentTarget.checked && !updateRememberedEmail('')) {
    showToast('No se pudo borrar el correo guardado en este navegador.');
  }
});
$('#verify-resend-form').addEventListener('submit', handleExpiredLinkResend);
$('#product-form').addEventListener('submit', handleProductSubmit);
$('#product-main-file').addEventListener('change', renderProductImagePreviews);
$('#product-extra-files').addEventListener('change', renderProductImagePreviews);
$('#user-form').addEventListener('submit', handleUserSubmit);
$('#user-password-form').addEventListener('submit', handleUserPasswordSubmit);
$('#dashboard').addEventListener('click', handleDashboardClick);
$('#confirm-checkout').addEventListener('click', confirmCheckout);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeOverlays();
});

initialize();
