# Stefbykurd

Tienda responsive en espanol para bolsos reutilizables. Incluye catalogo, busqueda, filtros, carrito, checkout de demostracion, inventario, cuentas por rol e historial de auditoria.

## Requisitos

- Node.js 22.15 o superior (incluye Node.js 26)
- npm

## Instalacion y ejecucion

```powershell
npm install
Copy-Item .env.example .env
```

Cada cambio en `main` publica una vista previa estatica en GitHub Pages. Esta vista permite explorar y filtrar el catalogo, ver productos, guardar favoritos y probar la bolsa en el navegador; el acceso a cuentas, las compras y la gestion requieren el servidor Node.js y no estan disponibles en la vista previa.

Edita `.env` y define `JWT_SECRET` con una cadena aleatoria de al menos 32 caracteres. Para crear al primer dueño, completa `OWNER_NAME`, `OWNER_EMAIL` y `OWNER_PASSWORD` (minimo 12 caracteres) y ejecuta:

```powershell
npm run create-owner
npm start
```

Abre `http://localhost:3000`. La base de datos SQLite se crea en `data/stefbykurd.sqlite` y el catalogo de ejemplo se carga automaticamente. `npm run dev` inicia el servidor con recarga automatica.

### Verificacion de correo

Las cuentas nuevas de comprador se guardan como registros pendientes. La tienda solo crea la cuenta y permite iniciar sesion despues de confirmar el enlace personal, que vence en 24 horas y se invalida al usarse. El inicio de sesion tambien exige esta verificacion para las cuentas buyer que existian antes de activar la funcion; el enlace se puede volver a solicitar desde la tienda. Las cuentas de vendedores y administradores creadas por el dueño o gerente no utilizan el registro publico y permanecen habilitadas.

Completa en `.env` `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD` y `SMTP_FROM` con los datos SMTP de tu proveedor. Para un proveedor que utilice autenticacion, crea y configura una contrasena de aplicacion, no compartas credenciales en el chat ni las subas al repositorio. Usa `SMTP_SECURE=true` para conexiones TLS directas, como el puerto 465; para STARTTLS en el puerto 587 usa `SMTP_SECURE=false`. Para un servidor sin autenticacion puedes dejar vacios `SMTP_USER` y `SMTP_PASSWORD`. `APP_BASE_URL` determina a que dominio enviara el enlace; en local puede ser `http://localhost:3000`, y en produccion debe ser el dominio HTTPS publico. Reinicia `npm start` despues de guardar la configuracion. Si falta SMTP, el catalogo sigue disponible, pero el registro y reenvio responderan con un error claro, sin crear cuentas de clientes.

En produccion configura `NODE_ENV=production`, un `JWT_SECRET` seguro y sirve la aplicacion exclusivamente mediante HTTPS. Las cookies de sesion pasan a ser `Secure` en ese entorno.

## Roles y protecciones

| Rol | Acceso |
| --- | --- |
| `buyer` | Registro publico, catalogo, bolsa y favoritos propios, checkout simulado e historial propio. |
| `seller` | Ve el inventario activo completo, incluidos los productos agotados, y puede crear o editar cualquier producto activo. Solo puede eliminar productos que haya publicado. No puede crear usuarios. |
| `manager` | Puede gestionar inventario, cuentas buyer/seller, transacciones globales y auditoria de vendedores. Solo un owner puede crear gerentes. |
| `owner` | Cuenta inicial creada por CLI; puede crear vendedores y gerentes, y tiene acceso completo de gestion. No hay registro publico de equipo ni de owners. |

Al crear un vendedor, el gerente define una contrasena inicial de al menos 10 caracteres y comparte el correo y la clave directamente con esa persona. El vendedor inicia sesion desde **Mi cuenta** y entra al panel con su rol. En la tabla de cuentas, **Cambiar clave** permite restablecer el acceso de vendedores activos; una cuenta suspendida debe reactivarse antes.

Cada producto admite alto, ancho y profundidad en centimetros, colores separados por coma, descripcion del diseno y hasta diez fotos adicionales. Desde el selector del inventario se cargan imagenes JPG, PNG o WebP directamente desde la PC o el celular (hasta 5 MB por foto). La tienda las guarda en `data/product-images`; el servidor valida el tipo y el contenido de cada archivo. En el catalogo, **Ver mas detalles** abre su ficha publica con galeria. El historial de compras conserva una instantanea de la foto y los detalles al momento del checkout, aunque el vendedor edite el producto despues. Los productos antiguos muestran los detalles disponibles; las especificaciones que nunca se cargaron se indican como no especificadas.

El servidor es la autoridad para los roles y los precios. El checkout vuelve a consultar stock y precio en una transaccion SQLite y revierte el pedido si cualquier articulo no tiene existencias. El pago es una simulacion: no se recopilan datos de tarjetas ni se conecta una pasarela.

Cada cuenta de comprador tiene su propia bolsa sincronizada con la base de datos; la bolsa de invitado se mantiene separada en ese navegador. Al iniciar o cerrar sesion, la tienda cambia entre ambas sin mezclar productos, incluso entre pestanas. La antigua bolsa compartida del navegador se descarta porque no es posible atribuir sus productos con seguridad a una cuenta. Los gerentes pueden consultar las bolsas actuales de todos los compradores desde el panel, incluidas las vacias, pero no modificarlas. Los favoritos tambien se guardan por comprador y aparecen en su perfil con la foto, disponibilidad y opcion para agregarlos a la bolsa.

Las sesiones usan JWT firmado en una cookie `HttpOnly`, `SameSite=Strict`, con expiracion de ocho horas. Al marcar «Recuérdame», la sesion permanece hasta 30 dias en ese dispositivo; no se guarda la contrasena en el navegador. Las contrasenas se almacenan con bcrypt; los endpoints de autenticacion tienen limite de intentos y las mutaciones validan el origen cuando el navegador lo envia. Helmet aplica cabeceras de seguridad y las entradas se validan en el servidor.

## Estructura

```text
server/
  app.js           Rutas, validacion, checkout, RBAC y auditoria
  auth.js          Sesion y middlewares isBuyer, isSeller e isManager
  db.js            Esquema SQLite nativo e inicializacion del catalogo
  email.js         SMTP, remitente y validacion del dominio de verificacion
  server.js        Arranque y cierre ordenado
  create-owner.js  Provisionamiento CLI del owner inicial
public/
  index.html       Tienda, modales y panel de gestion
  styles.css       Estilos responsive
  app.js           Interacciones del storefront y dashboard
public/assets/     Imagenes locales del catalogo
tests/
  app.test.js      Pruebas HTTP, verificacion de correo y permisos
```

## API principal

- `POST /api/auth/register`, `POST /api/auth/verify-email`, `POST /api/auth/resend-verification`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`
- `GET /api/products?q=&category=`
- `GET/PUT /api/cart/mine` (bolsa sincronizada y privada del comprador autenticado)
- `GET /api/favorites/mine`, `POST/DELETE /api/favorites/:productId`
- `POST /api/checkout`, `GET /api/transactions/mine`
- `GET/POST /api/seller/products`, `PUT/DELETE /api/seller/products/:id`
- `POST /api/seller/uploads` (carga autenticada de hasta 11 imagenes JPG, PNG o WebP)
- `GET /api/seller/audit` (acciones propias del vendedor)
- `GET /api/admin/summary`, `/api/admin/transactions`, `/api/admin/audit`, `/api/admin/users`, `/api/admin/carts`
- `POST /api/admin/users` (manager crea vendedores; owner tambien puede crear gerentes)
- `PATCH /api/admin/users/:id/password` (manager restablece la contrasena de un vendedor activo)
- `PATCH /api/admin/users/:id/status`, `DELETE /api/admin/users/:id`

Las transacciones y la auditoria global se consultan por paginas para que el panel pueda recorrer el historial completo. Las cuentas de clientes con transacciones se anonimizan y suspenden al eliminarlas para conservar la integridad del historial contable.

## Pruebas

```powershell
npm test
```
