<div align="center">

# Proofread

**Corrige y reescribe texto en cualquier cuadro de texto de Chrome, con un modelo de IA que corre en tu propia máquina.**

![Chrome MV3](https://img.shields.io/badge/Chrome-MV3-4285F4?logo=googlechrome&logoColor=white)
![Node](https://img.shields.io/badge/Node-sin_dependencias-339933?logo=nodedotjs&logoColor=white)
![100% local](https://img.shields.io/badge/100%25-local-0f766e)
![opencode](https://img.shields.io/badge/opencode-plan_gratuito-7c3aed)

</div>

---

Un prototipo con la forma de Grammarly: hacés foco en cualquier cuadro de texto, aparece
una pequeña **píldora** al lado del cursor, y con un clic el texto se reescribe usando un
**modelo gratuito de opencode corriendo en esta máquina**. Lo único que sale de la PC es
el pedido que hace el propio opencode.

```
extensión (Chrome MV3)  ->  backend en 127.0.0.1:8799  ->  opencode run  ->  plan gratuito de opencode zen
```

> [!NOTE]
> Por ahora solo funciona con modelos de **opencode**. No hay soporte para otros
> proveedores (OpenAI, Anthropic, Ollama y demás): el backend siempre lanza
> `opencode run` contra el plan gratuito de opencode zen.

## Cómo usarlo

El backend está instalado como servicio de usuario:

```sh
systemctl --user status proofread      # corriendo en http://127.0.0.1:8799
journalctl --user -u proofread -f
```

La extensión se carga una sola vez, a mano:

1. `chrome://extensions` -> activar **Modo de desarrollador**
2. **Cargar descomprimida** -> `~/Projects/proofread/extension`
3. Hacer clic en el ícono de la extensión para abrir las opciones y elegir un modelo.

Después, hacé clic en cualquier cuadro de texto. La píldora aparece al lado del cursor:
hacé clic en ella (o apretá **Ctrl+Shift+Y**) y elegí *Correct grammar*. Si primero
seleccionás una parte del texto, se reescribe solo esa parte; si no, se envía todo el campo.

## El proyecto completo

Seis archivos de código fuente. No hay paso de compilación ni dependencias: todo es
JavaScript puro, de Node y del navegador.

| Ruta | Qué hace |
| --- | --- |
| `backend/server.js` | Todo el backend: los prompts, el envoltorio de `opencode run` y la API HTTP (`/api/health`, `/api/models`, `/api/edit`) |
| `backend/workspace/` | Directorio de trabajo donde corre el agente; contiene `.opencode/agent/proofread.md` |
| `extension/shared.js` | Las opciones del menú y la configuración por defecto, cargadas por los tres contextos de la extensión para que existan en un solo lugar |
| `extension/content.js` | La píldora, el menú, su CSS, el diff palabra por palabra y la aplicación del resultado |
| `extension/background.js` | Habla con el backend (una página https no puede hacer fetch a `http://127.0.0.1`) |
| `extension/options.js` | Selector de modelo, URL del backend y qué opciones mostrar en el menú |

> [!TIP]
> Agregar una acción al menú son dos ediciones: la instrucción en `backend/server.js`
> y la etiqueta en `extension/shared.js`.

## Tests

```sh
node --test backend                        # unitarios + superficie HTTP, sin llamadas al modelo
node extension/browser-test.js             # Chromium y backend reales: píldora -> menú -> Replace
node extension/browser-test.js sites       # ¿aparece la píldora? fixtures + sitios reales
node extension/browser-test.js sites --only youtube --headful
node extension/browser-test.js --shot /tmp/shot.png
```

<details>
<summary><b>Dónde decide aparecer la píldora</b> (y por qué fue lo más difícil)</summary>

<br>

Para que funcione en sitios reales hizo falta una lista de exclusión, no una de inclusión:

- todos los `<input>` excepto password/hidden/checkbox/radio/file/button/submit/reset/image/range/color,
  todos los `<textarea>`, y cualquier cosa `contenteditable` o con el atributo `contenteditable`;
- el nodo enfocado se recorre **hacia arriba** seis niveles, porque los editores enfocan
  un hijo o un contenedor;
- `document.activeElement` se recorre **hacia abajo** a través de shadow roots abiertos
  (YouTube, Reddit);
- se ignoran los campos más chicos que 20x10 px (trampas de autocompletado y atajos);
- no se confía solo en los eventos de foco: el campo enfocado además se consulta cada
  400 ms, porque los campos con autofocus no disparan nada y las SPA mueven el foco en
  silencio. Ésta era la razón real por la que la píldora no aparecía en YouTube, Google
  ni Wikipedia.

`node extension/browser-test.js sites` es el test de regresión de todo eso: fixtures
locales con las formas que usan los editores (texto enriquecido con spans anidados,
contenedor con `role=textbox`, input dentro de un shadow root, autofocus, montaje tardío,
iframe) más un puñado de sitios reales.

</details>
