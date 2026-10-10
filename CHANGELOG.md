# Changelog

Todas las versiones relevantes de este proyecto se documentan aqui.
El formato sigue Keep a Changelog y el versionado es SemVer.

## [0.2.0] - 2026-10-10

### Anadido

- Bloque **salud del observador** en el informe: fichero de configuracion que gano,
  raiz del workspace, detectores activos, umbrales vigentes y `Observer errors`.
- Aviso explicito cuando la configuracion se rechaza, en lugar de correr en defaults
  sin decir nada.
- `Confirmed duplicates` y `Possible duplicates` separados: el motor ya distinguia
  duplicados con bytes identicos probados de conjeturas.
- El informe funciona antes de la primera llamada a herramienta, para que una sesion
  vacia demuestre que el observador esta cargado.

### Corregido

- El plugin se mediase a si mismo: cada llamada a `guardian_report` contaba como
  llamada observada y como duplicado, y mover los numeros que pretendias leer.
- En Windows, `isWithin` comparaba la raiz del workspace en crudo contra rutas ya
  normalizadas y daba `false`, marcando como "fuera del workspace" a todo comando
  normal que tocara un archivo del proyecto.
- `normalizePath` trata las rutas con letra de unidad o prefijo UNC como Windows
  aunque corra en POSIX, de modo que el resultado ya no depende de la maquina.
- `homedir()` se obtiene de `node:os` y no de las variables `HOME`/`USERPROFILE`.
- Un objeto `options` vacio (que es lo que el runtime entrega a los plugins cargados
  desde el directorio `plugins/`) ya no tapa tu fichero `tool-guardian.jsonc`: se
  corrian los valores por defecto en silencio. El contexto de pruebas ahora modela
  ese `{}` para que no vuelva a colarse.
- `.gitattributes` fija LF para que un CRLF no meta un caracter de retorno fantasma en
  el ultimo token del comando.

### Cambiado

- `Report.possibleDuplicates` pasa a `confirmedDuplicates` + `possibleDuplicates`, y
  anade `observerErrors`, `health`, `detectors` y `thresholds`.
- CI en `.github/workflows/tests.yml` (matriz ubuntu/macos/windows) y
  `release.yml` (GitHub release tras un push verde a main).

## [0.1.0] - 2026-10-10

Primera version funcional del MVP. Verificada contra OpenCode **2.0.26**.

### Anadido

- Motor de reglas puro y determinista, desacoplado de OpenCode:
  canonicalizacion de argumentos, huellas SHA-256 y clasificacion de herramientas.
- Detectores: duplicados (confirmados y posibles), bucles de fallo repetidos,
  riesgo de comandos, busqueda excesiva y estimacion de coste de salida.
- Integracion V2 mediante `tool.hook("execute.before" | "execute.after")`,
  `permission.hook("evaluate")` y `tool.transform`.
- Herramienta propia `guardian_report` para leer las metricas de la sesion.
- Modos `observe` (por defecto), `warn` y `enforce`.
- Aislamiento de estado por sesion con LRU y TTL acotados.
- Configuracion `tool-guardian.jsonc` validada con Zod; una configuracion
  invalida nunca lanza, cae a los valores por defecto y reporta el error.
- Analizador de argumentos de shell con comillas y operadores, para que un
  `rm -rf` entrecomillado nunca escale a bloqueo.

### Seguridad

- Por defecto no se bloquea nada: `policy.blockRules` esta vacio.
- El plugin nunca cambia un permiso a `allow`; solo puede escalar a `ask` o `deny`.
- Una herramienta desconocida o MCP se observa, nunca se modifica.
- Las huellas de estado se calculan sobre bytes crudos, sin transcodificar.

### No implementado

- Cache de resultados y reescritura de argumentos (ver README, seccion
  "Capacidades no implementadas").

[0.2.0]: https://github.com/zademy/opencode-tool-guardian/releases/tag/v0.2.0
[0.1.0]: https://github.com/zademy/opencode-tool-guardian/releases/tag/v0.1.0
