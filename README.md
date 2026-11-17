# Kivoz

Kivoz es un estudio web en español que lee en voz alta el chat público de un canal de Kick. Incluye cuentas con acceso por contraseña, preferencias separadas por usuario, modo claro/oscuro y un panel privado para administrar usuarios. Usa voces gratuitas del navegador y permite configurar el comando de activación (inicialmente `!aa`), velocidad, tono, volumen, lectura del usuario y reglas de moderación.

## Uso

Inicia sesión con tu cuenta, introduce un canal, pulsa **Conectar canal** y usa **Probar voz** para comprobar la salida de audio. Los comentarios con el comando seguido de un espacio y texto entran en la cola. El comando se elimina antes de leer el mensaje. Puedes pausar, saltar, borrar mensajes individuales o vaciar la cola. En **Reglas de lectura** puedes limitar roles, longitud, enlaces, emotes, palabras y frecuencia por usuario. **Guardar cambios** conserva las preferencias en tu cuenta; el tema elegido también se recuerda para ese usuario.

Mantén la pestaña abierta y con sonido durante el directo. Para transmitir las voces, captura el audio del navegador en OBS. Las voces dependen del sistema operativo y del navegador; algunas necesitan Internet. Se recomienda Chrome o Edge con voces en español instaladas.

El administrador puede crear cuentas de usuario desde **Configuración**. Las nuevas cuentas tienen acceso al estudio, pero no al panel administrativo. La misma pantalla permite revocar su acceso. La primera cuenta administradora se crea una sola vez con un token secreto configurado en el servidor; no hay credenciales predeterminadas ni registro público. Las preferencias anónimas guardadas antes de habilitar cuentas no se asignan automáticamente: vuelve a guardarlas después de iniciar sesión para asociarlas a tu cuenta.

La conexión usa el endpoint público de canales de Kick y su transporte público Pusher. No solicita credenciales de Kick ni publica mensajes. Es una integración no oficial: Kick puede cambiar o restringir estos servicios, en cuyo caso la aplicación muestra un error. No se introducen mensajes o métricas simulados. La actividad muestra los últimos 150 mensajes de la sesión; la cola admite 50 mensajes pendientes. No recupera mensajes perdidos durante una desconexión.

## Tecnologías

React, Vite, Lucide, CSS adaptable, Web Speech API y Pusher JS en el navegador. Express en Netlify Server resuelve los canales, autentica cuentas y guarda usuarios, sesiones y preferencias por usuario en Netlify Database (Postgres), mediante Drizzle ORM. Las contraseñas se derivan con scrypt; el servidor guarda solo el hash de cada token de sesión, y la cookie de sesión es HttpOnly, Secure y SameSite=Strict. Las sesiones caducan a los 30 días. La cola, los contadores y la actividad son temporales y se eliminan al recargar.

## Primer acceso y administración

1. Genera un token aleatorio de al menos 32 caracteres, por ejemplo con `node -p "require('node:crypto').randomBytes(32).toString('hex')"`.
2. Configura el resultado como variable de entorno `KIVOZ_ADMIN_SETUP_TOKEN` en el entorno de despliegue de Netlify. No lo incluyas en el repositorio ni lo compartas con los usuarios.
3. Después de desplegar, abre Kivoz y crea el primer administrador con ese token y una contraseña de al menos 12 caracteres. El alta inicial se cierra automáticamente cuando ya existe una cuenta.
4. Entra en **Configuración** para crear cuentas normales, eliminar usuarios, cambiar tu contraseña y el tema, y guardar preferencias. Las cuentas administradoras no se pueden eliminar desde el panel.

Si la base de datos no contiene una cuenta y falta el token de despliegue, la aplicación bloquea el acceso y muestra cómo habilitar el alta inicial. No hay un bypass de desarrollo ni una contraseña de respaldo.

## Desarrollo local

Requiere Node.js 24 o posterior y un proyecto Netlify vinculado.

```sh
npm install
netlify dev --port 8889
```

Netlify Dev ejecuta el frontend y emula el backend. Define `KIVOZ_ADMIN_SETUP_TOKEN` en el entorno local antes de crear la primera cuenta. La plataforma provisiona la base de datos y aplica las migraciones durante el despliegue. No se necesitan claves de proveedor de voces ni credenciales de Kick.

El código fuente está en `src/`, el servidor en `netlify/server/` y el esquema en `db/schema.ts`. Los cambios de esquema deben acompañarse de una migración generada con `npx drizzle-kit generate --name nombre_descriptivo`. No apliques las migraciones manualmente.
