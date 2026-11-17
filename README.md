# Kivoz

Kivoz es un estudio web en español que lee en voz alta el chat público de un canal de Kick. Usa voces gratuitas del navegador y permite configurar el comando de activación (inicialmente `!aa`), velocidad, tono, volumen, lectura del usuario y reglas de moderación.

## Uso

Introduce un canal, pulsa **Conectar canal** y usa **Probar voz** para comprobar la salida de audio. Los comentarios con el comando seguido de un espacio y texto entran en la cola. El comando se elimina antes de leer el mensaje. Puedes pausar, saltar, borrar mensajes individuales o vaciar la cola. En **Reglas de lectura** puedes limitar roles, longitud, enlaces, emotes, palabras y frecuencia por usuario. **Guardar cambios** conserva las preferencias de este navegador.

Mantén la pestaña abierta y con sonido durante el directo. Para transmitir las voces, captura el audio del navegador en OBS. Las voces dependen del sistema operativo y del navegador; algunas necesitan Internet. Se recomienda Chrome o Edge con voces en español instaladas.

La conexión usa el endpoint público de canales de Kick y su transporte público Pusher. No solicita credenciales de Kick ni publica mensajes. Es una integración no oficial: Kick puede cambiar o restringir estos servicios, en cuyo caso la aplicación muestra un error. No se introducen mensajes o métricas simulados. La actividad muestra los últimos 150 mensajes de la sesión; la cola admite 50 mensajes pendientes. No recupera mensajes perdidos durante una desconexión.

## Tecnologías

React, Vite, Lucide, CSS adaptable, Web Speech API y Pusher JS en el navegador. Express en Netlify Server resuelve los canales y guarda preferencias en Netlify Database (Postgres), mediante Drizzle ORM. Una cookie HttpOnly y SameSite asocia las preferencias a cada navegador sin crear cuentas. Borrar la cookie pierde el acceso a esas preferencias. La cola, los contadores y la actividad son temporales y se eliminan al recargar.

## Desarrollo local

Requiere Node.js 24 o posterior y un proyecto Netlify vinculado.

```sh
npm install
netlify dev --port 8889
```

Netlify Dev ejecuta el frontend y emula el backend. La plataforma provisiona la base de datos y aplica las migraciones durante el despliegue. No se necesitan claves de proveedor de voces ni credenciales de Kick.

El código fuente está en `src/`, el servidor en `netlify/server/` y el esquema en `db/schema.ts`. Los cambios de esquema deben acompañarse de una migración generada con `npx drizzle-kit generate --name nombre_descriptivo`. No apliques las migraciones manualmente.
