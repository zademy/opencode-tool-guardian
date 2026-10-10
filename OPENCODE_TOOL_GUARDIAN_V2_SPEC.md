# OpenCode Tool Guardian — Especificación de implementación para OpenCode V2

**Estado:** propuesta de desarrollo, no plugin existente.  
**Objetivo:** construir y probar un plugin instalable, no entregar solamente una arquitectura.  
**Nombre propuesto:** `opencode-tool-guardian`  
**Compatibilidad objetivo:** OpenCode V2; Windows, macOS y Linux.  
**Filosofía:** determinista, local-first, seguro por defecto y cero llamadas adicionales a LLM.

> **Instrucción para el agente:** Implementa este documento en el repositorio actual. Investiga primero la API real de la versión de OpenCode V2 instalada y corrige los ejemplos de esta especificación si los tipos o contratos vigentes difieren. No uses la API V1 ni supongas que un hook puede sustituir completamente la ejecución de una herramienta sin pruebas. Trabaja por fases, implementa pruebas y deja el proyecto compilando y documentado.

## 1. Problema

Los agentes de programación consumen tiempo, tokens y recursos al:

- repetir comandos fallidos sin cambios relevantes;
- leer archivos sin modificaciones una y otra vez;
- lanzar búsquedas recursivas con alcance innecesariamente amplio;
- repetir compilaciones o tests sin comprender los errores;
- ejecutar herramientas con parámetros inesperados o peligrosos;
- producir resultados enormes que después el modelo debe procesar;
- usar herramientas que alteran archivos sin necesidad.

Tool Guardian **no reemplaza al modelo ni elige la solución de programación**. Examina cada llamada a herramientas, aplica reglas verificables y registra observaciones. Cuando tenga evidencia inequívoca, puede bloquear mediante mecanismos soportados oficialmente. Ante incertidumbre, solo debe advertir.

### Principios no negociables

1. **Sin LLM:** no llamar a modelos, embeddings, proveedores de IA ni servicios externos.
2. **Predecible:** entradas equivalentes bajo el mismo estado y configuración producen las mismas decisiones.
3. **Observabilidad primero:** versión inicial en modo `observe`, sin modificar comandos.
4. **No reescritura silenciosa:** modificar argumentos solo en reglas expresamente activadas, comprobadas como seguras y reversibles.
5. **No pérdida de resultados:** nunca truncar, sustituir o eliminar outputs a ciegas.
6. **Seguridad:** no ejecutar o validar comandos mediante `eval`, shells auxiliares o expresiones regulares ingenuas usadas como parser integral.
7. **No asumir intención:** una búsqueda amplia, test repetido o compilación completa puede ser legítima.
8. **Priorizar la tarea del usuario:** el usuario puede solicitar explícitamente búsquedas completas o comprobaciones repetidas.
9. **Privacidad:** métricas sin guardar código, secretos, prompts completos ni outputs sensibles.
10. **Compatibilidad:** no interferir con Context Mode, Ponytail, Hashline o Encoding Guard.

## 2. Referencias oficiales que el agente debe verificar

Consultar primero documentación y definiciones de tipos actuales:

- https://opencode.ai/v2/docs/build/plugins/
- https://opencode.ai/v2/docs/build/plugins/migrate-v1/
- https://opencode.ai/v2/docs/build/plugins/effect
- https://opencode.ai/v2/docs/
- https://github.com/anomalyco/opencode/tree/dev/packages/plugin/src/v2

Verificar específicamente:

- paquete e import correcto (`@opencode-ai/plugin/v2` o entrypoint actualmente documentado para la versión instalada);
- `Plugin.define({ id, setup })`;
- `ctx.tool.hook("execute.before", callback)`;
- `ctx.tool.hook("execute.after", callback)`;
- `ctx.shell.hook("create.before", callback)` si aporta valor real;
- API de permisos (`ctx.permission...`) **solo** tras verificar tipo y semántica actuales;
- registro de herramientas y comandos propios, si está soportado por `ctx.tool.transform` / `ctx.command.transform`;
- forma de identificar sesión, operación, herramienta, cwd, error y duración;
- qué objetos pueden modificarse en el callback y qué ocurre si el hook arroja un error;
- configuración V2 y ciclo de vida / limpieza de registros.

**Nota crítica:** `execute.before` puede modificar el input, pero **no debe asumirse** que puede devolver un resultado cacheado en lugar de ejecutar la herramienta. El caché de resultados será experimental hasta verificar un mecanismo oficial de sustitución o una herramienta controlada por el propio plugin.

## 3. Alcance funcional del MVP 0.1.0

### 3.1 Tool Inspector

Observar las herramientas que pasan por hooks V2, registrar nombre, clase de herramienta y metadatos seguros. Soportar herramientas nativas y, cuando sea posible según su contrato, MCPs, sin depender de una lista cerrada de nombres.

Clasificar sin atribuir semántica desconocida:

- lectura: `read`, `grep`, `glob` y equivalentes reconocidos;
- ejecución: `bash`, shell y equivalentes reconocidos;
- modificación: `edit`, `write`, `apply_patch` y editores de terceros (solo observar si no existe contrato verificable);
- desconocida: observar sin alterar.

No deducir que una herramienta es read-only a partir de su nombre si no existe una declaración fiable.

### 3.2 Duplicate Detector

Detectar repeticiones mediante una huella estable:

```text
fingerprint = SHA256(
  toolID + canonicalArguments + cwd + relevantStateFingerprint
)
```

- Canonicalizar JSON de forma estable, ordenando claves sin modificar semántica de arrays o strings.
- Normalizar rutas cuidadosamente, respetando Windows y sensibilidad del filesystem.
- Para lecturas de **un solo archivo**, incorporar hash del contenido, o metadatos con invalidación fiable.
- Para comandos que dependen del entorno, del tiempo, la red o procesos externos, no declarar equivalencia solamente por el hash del repositorio.
- Cuando no pueda probarse igualdad de estado, registrar como `possible_duplicate`, no como duplicado seguro.
- No compartir automáticamente caché entre sesiones, usuarios o proyectos.

**MVP:** detectar y advertir; **NO** suprimir una ejecución por defecto.

### 3.3 Failure Loop Detector

Observar fallos repetidos del mismo comando o herramienta:

```text
same tool + same canonical input + same cwd
+ same relevant state (if provable)
+ equivalent failure signature
= repeated failure candidate
```

La firma de error puede incluir código de salida, categoría y digest de texto normalizado **sin almacenar el error completo**. Conservar suficiente contexto en memoria solo durante la sesión, con retención limitada.

Política predeterminada:

- primer fallo: permitir;
- segundo fallo equivalente: registrar;
- tercer fallo equivalente sin cambios probados: advertir al agente mediante un canal oficial y conciso, si está disponible;
- **no bloquear automáticamente** reintentos en la V0.1.

No declarar que `mvn test` es redundante solo porque el repositorio no cambió: procesos, cachés, servicios, variables, archivos generados y pruebas flaky pueden alterar el resultado.

### 3.4 Command Risk Analyzer

Clasificar riesgos de forma conservadora:

- rutas fuera del workspace;
- destrucción masiva o eliminación de la raíz del proyecto;
- cambios de permisos de alcance amplio;
- escritura en rutas sensibles;
- ejecución con privilegios elevados;
- argumentos obviamente inconsistentes o peligrosos.

La política oficial de permisos de OpenCode debe permanecer como **fuente principal de autorización**. Tool Guardian no concede permisos ni intenta eludir confirmaciones existentes.

**No bloquear comandos basándose solo en una coincidencia de subcadenas.** Ejemplos: una cadena `rm -rf` dentro de `echo`, comillas, comentarios o una documentación no constituye una eliminación. Para acciones de bloqueo, usar análisis fiable de argumentos o reglas restringidas a herramientas estructuradas. Si no hay parser robusto: **WARN, no BLOCK**.

Reglas de bloqueo predeterminadas solo cuando la acción violente una política explícita y la detección sea inequívoca. Integrar con el mecanismo V2 de permisos únicamente si se comprueba su API real.

### 3.5 Excessive Search Advisor

Detectar patrones de exploración posiblemente costosos:

- recursión desde la raíz sin exclusiones;
- resultados repetidos muy extensos;
- búsquedas de texto en directorios típicamente generados (`node_modules`, `.git`, `target`, `dist`, `build`);
- lectura excesiva de archivos binarios.

Sugerir comandos alternativos como `rg` o limitar la ruta cuando corresponda, **pero no sustituir silenciosamente** `grep`/`find` por `rg`: no siempre están instalados ni tienen idéntica semántica. No inventar equivalencias para filtros, enlaces simbólicos, codificaciones o expresiones regulares.

### 3.6 Output Cost Estimator

Estimar tamaño de outputs observados:

- caracteres y bytes;
- número de líneas;
- tokens **estimados**, claramente marcados, utilizando un tokenizador local configurable cuando sea viable;
- tamaño antes y después de la intervención de otros plugins, solo cuando el orden de hooks y visibilidad permitan una comparación válida.

No afirmar que `bytes evitados == tokens facturados ahorrados`. Las cifras de tokens, latencia y coste reales solo pueden verificarse con métricas expuestas por el proveedor o OpenCode.

No truncar outputs: **Context Mode es el dueño de esa responsabilidad**.

### 3.7 Reportes

Exponer, si el API V2 lo permite, una herramienta/command de lectura como `guardian_report`, y documentar alternativa CLI local si no hay comandos V2 apropiados.

Ejemplo de reporte:

```text
OpenCode Tool Guardian — Session Report
Tool calls observed:             84
Possible duplicates:            12
Repeated-failure candidates:     5
Risk warnings:                   2
Large outputs:                   8
Tool input rewrites:             0
Confirmed actions blocked:       0
Estimated tokens in outputs:  9,200 (local estimate)
```

**No mostrar tokens ahorrados** si solo hubo advertencias y no se evitó una ejecución o contenido de manera comprobable.

## 4. Modos

- `observe` (predeterminado): registrar y medir, sin alterar inputs ni bloquear.
- `warn`: emitir advertencias breves y no invasivas por mecanismos oficiales; limitar frecuencia.
- `enforce`: bloquear solo violaciones inequívocas de reglas explícitamente habilitadas y con soporte real en V2.

La configuración debe permitir excluir herramientas, proyectos o rutas y deshabilitar cada detector por separado.

## 5. Política de compatibilidad

### Context Mode

- No reducir, resumir, indexar ni transformar outputs para el modelo.
- No duplicar funcionalidades de compaction o retrieval.
- Evitar hooks de `session.context`/`session.request` salvo que exista una justificación comprobada.
- Medir cuando sea posible sin asumir que el orden de hooks será invariable entre instalaciones.

### Ponytail

- No insertar reglas nuevas de estilo o arquitectura de código.
- El plugin observa herramientas; Ponytail orienta comportamiento del agente.

### Hashline

- No reescribir argumentos de sus herramientas de edición.
- No tocar identificadores, anclas o hash de líneas.
- Observar llamadas a herramientas de edición sin intervenir en sus contratos privados.

### Encoding Guard

- No escribir ni recodificar archivos fuente.
- No cambiar saltos de línea, BOM o encoding.
- No usar lectura/escritura textual para calcular hashes: leer bytes crudos.

### Otros MCPs

- Unknown MCP tool = observar si hay metadatos seguros, **sin optimizar o bloquear** salvo una política inequívoca.
- Las acciones remotas pueden producir efectos secundarios; nunca cachear resultados ciegamente.

## 6. Configuración sugerida

Mantener configuración del plugin separada de `opencode.json` cuando el esquema oficial no admita las propiedades personalizadas. Ejemplo `tool-guardian.jsonc`:

```jsonc
{
  "enabled": true,
  "mode": "observe",
  "detectors": {
    "duplicates": true,
    "repeatedFailures": true,
    "commandRisk": true,
    "excessiveSearch": true,
    "outputCost": true
  },
  "thresholds": {
    "repeatedFailureCount": 3,
    "largeOutputLines": 1500,
    "maxTrackedOperations": 2000
  },
  "privacy": {
    "storeRawToolOutput": false,
    "storeFullCommands": false,
    "redactSecrets": true
  },
  "cache": {
    "enabled": false
  },
  "rewrites": {
    "enabled": false
  },
  "excludedTools": [],
  "excludedPaths": [".git/**", "node_modules/**", "target/**", "dist/**", "build/**"]
}
```

El esquema es del plugin propuesto, **no** una propiedad oficial de OpenCode. Validar con Zod u otra librería de esquema tipado. Rechazar o reportar configuraciones inválidas y documentar defaults.

## 7. Diseño técnico

```text
src/
  index.ts                     # entrada OpenCode V2
  opencode/
    plugin.ts                  # registro de hooks, scope/cleanup
    tool-adapter.ts            # adaptación a eventos V2 tipados
    report-adapter.ts          # herramienta/comando si existe API pública
  core/
    engine.ts                  # decisión pura
    policy.ts                  # reglas y severidad
    canonicalize.ts            # argumentos canónicos
    fingerprints.ts            # huellas del estado
    detector-duplicates.ts
    detector-failures.ts
    detector-risk.ts
    detector-search.ts
    estimator-output.ts
    models.ts
  platform/
    paths.ts                   # rutas Windows/macOS/Linux
    process.ts
    files.ts
  state/
    session-store.ts           # LRU con TTL, aislamiento por sesión
    metrics.ts
  config/
    schema.ts
    loader.ts
  reporting/
    report.ts
  tests/
    unit/
    integration/
    fixtures/
```

Mantener **el motor de reglas desacoplado de OpenCode** para pruebas deterministas y un adaptador pequeño para V2.

### Tipos conceptuales

```ts
type Decision =
  | { action: "allow"; rules: string[] }
  | { action: "warn"; rules: string[]; message: string }
  | { action: "block"; rules: string[]; reason: string };

interface ToolInvocation {
  toolId: string;
  arguments: unknown;
  cwd?: string;
  sessionId?: string;
}
```

No tratar tipos inventados como si fueran exports del SDK.

## 8. Ejemplo de hook V2 (ilustrativo)

Según la documentación V2 consultada en octubre de 2026:

```ts
import { Plugin } from "@opencode-ai/plugin/v2";

export default Plugin.define({
  id: "tool-guardian",
  setup: async (ctx) => {
    await ctx.tool.hook("execute.before", async (event) => {
      // Normalizar de forma segura los campos reales de event.
      // En modo observe, NO modificar event.input.
      // Registrar decisión solo con APIs soportadas.
    });

    await ctx.tool.hook("execute.after", async (event) => {
      // Revisar event.status y sus resultados/errores tipados.
      // Registrar métricas redaccionadas.
    });
  },
});
```

Verificar el import en la instalación real porque OpenCode V2 sigue evolucionando. No mezclar en el mismo adaptador modelos de eventos de V1 y V2.

## 9. Concurrencia, persistencia y privacidad

- Aislar métricas por sesión y workspace.
- Asociar `before` y `after` usando IDs oficiales si existen; si no, crear correlación acotada con garantías y pruebas; evitar un solo `lastCommand` global.
- Soportar ejecuciones paralelas y reentrantes.
- Nunca escribir código fuente, variables de entorno, tokens, contraseñas, headers ni outputs completos en disco.
- Guardar solo estadísticas agregadas de forma predeterminada. Si se activa persistencia, usar un directorio de datos adecuado por sistema operativo y una política de retención.
- No depender de `/tmp`, `/bin/bash`, utilidades GNU ni separadores `/` para operar en Windows.
- No desactivar ni reemplazar los permisos del sistema de herramientas de OpenCode.
- Los errores internos del observador no deben romper ejecuciones legítimas en modo `observe`; registrar fallos sin filtrar secretos.

## 10. Cache y optimización — NO forman parte del MVP

La versión 0.2 puede investigar reutilización de resultados **solo** si es posible demostrar:

1. lectura pura, sin efectos secundarios;
2. mismas entradas, entorno y estado relevante;
3. mecanismo V2 oficialmente soportado para devolver un resultado sin ejecutar la herramienta, o una herramienta propia que controle esa ejecución;
4. invalidación correcta al modificar archivos o configuración;
5. métricas de ahorro comprobables.

Un `execute.before` que únicamente cambia `input` **no demuestra** capacidad para saltarse la ejecución original. Nunca falsificar esa capacidad.

Las reescrituras automáticas quedan apagadas hasta contar con pruebas de equivalencia semántica y autorización explícita.

## 11. Pruebas obligatorias

### Unitarias

- Canonicalización consistente con claves JSON reordenadas.
- Los arrays mantienen su orden.
- Comandos en distintos `cwd` no se consideran idénticos.
- Lectura del mismo archivo con hash diferente invalida la igualdad.
- Estado no demostrable produce `possible_duplicate`.
- Error repetido con cambio de entradas o estado no dispara falso positivo.
- Comando peligroso dentro de una cadena entrecomillada no dispara bloqueo.
- Un comando destructivo explícito y estructurado se detecta bajo una regla habilitada.
- Un comando amplio autorizado por el usuario no se reescribe.
- Paths Windows con espacios, `C:\...`, UNC, macOS y Linux.
- Symlinks, rutas relativas y traversal.
- Herramienta MCP desconocida no se modifica.
- Datos sensibles nunca aparecen en reportes.

### Integración V2

- Plugin carga con un OpenCode V2 real.
- Hooks `execute.before` y `execute.after` se ejecutan.
- Se observan salidas exitosas y fallidas.
- La desactivación/reload limpia correctamente registros.
- Dos operaciones paralelas mantienen correlación correcta.
- `observe` no modifica argumentos, resultados ni archivos.
- Funciona con Context Mode, Ponytail y Hashline instalados simultáneamente, con versiones verificadas.
- No altera archivos ISO-8859-1/Windows-1252/UTF-8 (verificación de bytes).
- No perjudica pruebas y compilaciones en Windows, macOS y Linux.

### Benchmarks

Crear fixtures con sesiones reproducibles que comparen OpenCode sin Guardian y con Guardian:

- número de llamadas observadas;
- costo temporal adicional por hook (p50/p95);
- memoria máxima;
- falsos positivos;
- cantidad de advertencias útiles;
- tokens facturados **solo** cuando existan métricas fiables del proveedor;
- cero regresiones en ejecuciones funcionales.

Evitar publicar cifras de ahorro hipotéticas como mediciones reales.

## 12. Etapas de implementación

### Fase 0: validar el contrato V2

- Leer documentación oficial, tipos instalados y ejemplos reales.
- Comprobar API de hooks, shell, permisos, herramientas y comandos.
- Documentar APIs disponibles y limitaciones.

### Fase 1: motor independiente

- Configuración tipada.
- Normalización y huellas.
- Duplicate Detector.
- Failure Loop Detector.
- Unit tests.

### Fase 2: plugin operativo

- Integración `execute.before` / `execute.after`.
- Estado acotado por sesión.
- Modo `observe`.
- Registro seguro.

### Fase 3: seguridad y diagnóstico

- Risk Analyzer conservador.
- Excessive Search Advisor.
- Output Cost Estimator.
- Reporte.
- Modo `warn`.

### Fase 4: verificación

- Integración V2 real.
- Pruebas multiplataforma.
- Pruebas de coexistencia.
- Perfilado de latencia.
- README y documentación de instalación.

### Fase 5: posterior al MVP

- Estudiar caché segura de herramientas propias.
- Policy `enforce` para violaciones explícitas.
- Optimizaciones o reescrituras con pruebas de equivalencia.

## 13. Entregables obligatorios

- Código TypeScript compilable e instalable en OpenCode V2.
- `package.json` completo, versiones compatibles, scripts de build/test/typecheck/lint.
- README en español con instalación en Windows, macOS y Linux.
- Configuración de ejemplo sin propiedades falsas en `opencode.json`.
- Config schema y valores predeterminados.
- Pruebas unitarias e integración.
- `CHANGELOG.md`, licencia abierta apropiada y `.gitignore`.
- Instrucciones para desarrollo local y publicación npm, sin inventar URL de repositorio.
- Evidencia de resultados reales de pruebas, no solamente afirmaciones.
- Lista explícita de capacidades no implementadas porque V2 no las permite.

## 14. Criterios de aceptación / Definition of Done

1. El plugin se instala y arranca con una versión concreta de OpenCode V2.
2. No realiza ninguna llamada a LLM ni consume tokens para tomar decisiones.
3. En `observe`, las herramientas ejecutan igual que sin el plugin.
4. Detecta duplicados potenciales y fallos repetidos sin asumir falsamente equivalencia de estado.
5. Clasifica advertencias de riesgo y búsqueda sin bloquear casos ambiguos.
6. Respeta el sistema de permisos original de OpenCode.
7. No trunca outputs ni compite con Context Mode.
8. No modifica argumentos de Hashline ni reglas de Ponytail.
9. No altera bytes ni encodings de archivos legacy.
10. Tiene métricas honestas y un reporte operativo.
11. Tiene pruebas reproducibles, typecheck y build satisfactorios.
12. Documenta diferencias encontradas entre la API V2 real y esta especificación.

## 15. Instrucción final al agente

**No termines al producir un plan.** Implementa la versión 0.1.0 funcional, verifica la API V2 actual, escribe pruebas y ejecútalas. Si alguna capacidad es imposible mediante hooks públicos, **no inventes APIs**: entrega la mejor alternativa soportada y anota claramente la limitación. Mantén el MVP pequeño, confiable, determinista y compatible con los otros plugins existentes.

---

**Resumen del producto:** Context Mode optimiza lo que llega al modelo; Ponytail orienta buenas prácticas; Hashline mejora la precisión de edición; Tool Guardian analiza **cuándo y cómo se invocan herramientas** y ayuda a evitar desperdicio y riesgo antes de ejecutarlas.
