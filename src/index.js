import { XMLParser } from "fast-xml-parser";

export default {
  async fetch(request, env, ctx) {
    // 1. VALIDACIÓN DE SEGURIDAD (CF-Connecting-IP)
    const clientIP = request.headers.get("CF-Connecting-IP");
    const allowedList = (env.ALLOWED_IPS || "")
      .split(",")
      .map((ip) => ip.trim())
      .filter(Boolean);

    if (!clientIP || !isIPAllowed(clientIP, allowedList)) {
      return new Response(renderForbiddenHTML(clientIP), {
        status: 403,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // Solo permitir peticiones GET
    if (request.method !== "GET") {
      return new Response("Método no permitido", { status: 405 });
    }

    const xmlUrl = env.XML_URL || "https://360net-publico.s3.amazonaws.com/phonebook.xml";
    const cacheTTL = parseInt(env.CACHE_TTL || "900", 10);

    try {
      // 2. GESTIÓN DE DATOS Y CACHÉ EN EL BORDE
      const { xmlText, cacheStatus, lastUpdated } = await fetchXMLWithCache(
        xmlUrl,
        cacheTTL,
        ctx
      );

      // 3. PARSEO XML A JSON ESTRUCTURADO
      const directory = parsePhonebookXML(xmlText);

      // 4. RENDERIZADO DE INTERFAZ RESPONSIVA
      const html = renderDirectoryHTML(directory, {
        cacheStatus,
        lastUpdated,
        clientIP,
      });

      return new Response(html, {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "X-Cache-Status": cacheStatus,
        },
      });
    } catch (error) {
      return new Response(
        `<h1>Error interno al procesar el directorio</h1><p>${escapeHTML(error.message)}</p>`,
        {
          status: 502,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        }
      );
    }
  },
};

/**
 * Valida si una IP IPv4 coincide con una IP exacta o un rango CIDR en la lista blanca
 */
function isIPAllowed(clientIP, allowedList) {
  return allowedList.some((entry) => {
    if (entry.includes("/")) {
      return isIPv4InCIDR(clientIP, entry);
    }
    return clientIP === entry;
  });
}

function isIPv4InCIDR(ip, cidr) {
  const [range, bitsStr] = cidr.split("/");
  const bits = parseInt(bitsStr, 10);
  if (isNaN(bits) || bits < 0 || bits > 32) return false;

  const ipInt = ipv4ToInt(ip);
  const rangeInt = ipv4ToInt(range);
  if (ipInt === null || rangeInt === null) return false;

  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipInt & mask) === (rangeInt & mask);
}

function ipv4ToInt(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let num = 0;
  for (const part of parts) {
    const n = parseInt(part, 10);
    if (isNaN(n) || n < 0 || n > 255) return null;
    num = (num << 8) + n;
  }
  return num >>> 0;
}

/**
 * Obtiene el XML desde Cloudflare Cache API o lo descarga de S3 si expiró
 */
async function fetchXMLWithCache(xmlUrl, ttlSeconds, ctx) {
  const cache = caches.default;
  const cacheKey = new Request(xmlUrl, { method: "GET" });

  let cachedResponse = await cache.match(cacheKey);
  if (cachedResponse) {
    const xmlText = await cachedResponse.text();
    const lastUpdated = cachedResponse.headers.get("X-Synced-At") || new Date().toISOString();
    return { xmlText, cacheStatus: "HIT", lastUpdated };
  }

  const originResponse = await fetch(xmlUrl);
  if (!originResponse.ok) {
    throw new Error(`No se pudo descargar el XML desde S3 (HTTP ${originResponse.status})`);
  }

  const xmlText = await originResponse.text();
  const syncedAt = new Date().toISOString();

  const responseToCache = new Response(xmlText, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": `public, max-age=${ttlSeconds}`,
      "X-Synced-At": syncedAt,
    },
  });

  ctx.waitUntil(cache.put(cacheKey, responseToCache));

  return { xmlText, cacheStatus: "MISS", lastUpdated: syncedAt };
}

/**
 * Convierte y normaliza el XML de telefonía IP (Yealink, Grandstream, Cisco o genérico)
 */
function parsePhonebookXML(xmlText) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    trimValues: true,
  });

  const parsed = parser.parse(xmlText);
  const rawEntries = extractEntriesRecursive(parsed);

  return rawEntries
    .map((item) => {
      const name =
        item.Name ||
        item.name ||
        [item.FirstName || item.firstName, item.LastName || item.lastName]
          .filter(Boolean)
          .join(" ") ||
        item.Title ||
        "Sin Nombre";

      const extension = String(
        item.Telephone ||
          item.telephone ||
          item.Phone?.phonenumber ||
          item.Phone ||
          item.phone ||
          item.Extension ||
          item.extension ||
          item.Number ||
          item.number ||
          ""
      ).trim();

      const department = String(
        item.Department ||
          item.department ||
          item.Group ||
          item.group ||
          item.Category ||
          item.category ||
          "General"
      ).trim();

      const notes = String(
        item.Email ||
          item.email ||
          item.Notes ||
          item.notes ||
          item.Position ||
          item.position ||
          ""
      ).trim();

      return { name: String(name).trim(), extension, department, notes };
    })
    .filter((entry) => entry.extension !== "")
    .sort((a, b) => a.name.localeCompare(b.name, "es"));
}

function extractEntriesRecursive(obj) {
  if (!obj || typeof obj !== "object") return [];
  const candidateKeys = [
    "DirectoryEntry",
    "Contact",
    "Entry",
    "Item",
    "Extension",
    "directoryentry",
    "contact",
    "entry",
  ];

  for (const key of candidateKeys) {
    if (obj[key]) {
      return Array.isArray(obj[key]) ? obj[key] : [obj[key]];
    }
  }

  for (const val of Object.values(obj)) {
    if (typeof val === "object") {
      const found = extractEntriesRecursive(val);
      if (found.length > 0) return found;
    }
  }

  return [];
}

function escapeHTML(str) {
  return String(str)
    .replace(/&/g, "&")
    .replace(/</g, "<")
    .replace(/>/g, ">")
    .replace(/"/g, """);
}

/**
 * Pantalla HTTP 403 para IPs no autorizadas
 */
function renderForbiddenHTML(ip) {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Acceso Restringido - Directorio Corporativo</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-900 text-slate-100 min-h-screen flex items-center justify-center p-4">
  <div class="max-w-md w-full bg-slate-800 border border-red-500/40 rounded-2xl p-8 text-center shadow-2xl">
    <div class="w-16 h-16 bg-red-500/10 text-red-400 rounded-full flex items-center justify-center mx-auto mb-4 text-3xl">
      🔒
    </div>
    <h1 class="text-2xl font-bold text-white mb-2">Acceso Denegado (403)</h1>
    <p class="text-slate-300 text-sm mb-6">
      Este directorio telefónico es de uso exclusivo para las redes internas autorizadas de la oficina.
    </p>
    <div class="bg-slate-900/80 rounded-lg p-3 text-xs font-mono text-slate-400 border border-slate-700">
      IP detectada: <span class="text-red-400 font-semibold">${escapeHTML(ip || "Desconocida")}</span>
    </div>
  </div>
</body>
</html>`;
}

/**
 * Interfaz principal del Directorio (Móvil + Escritorio)
 */
function renderDirectoryHTML(directory, meta) {
  const departments = [...new Set(directory.map((d) => d.department))].sort((a, b) =>
    a.localeCompare(b, "es")
  );
  const safeJSON = JSON.stringify(directory).replace(/</g, "\\u003c");

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Directorio Telefónico Corporativo</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-50 text-slate-800 min-h-screen flex flex-col">

  <!-- CABECERA -->
  <header class="bg-slate-900 text-white shadow-md sticky top-0 z-20">
    <div class="max-w-6xl mx-auto px-4 py-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
      <div class="flex items-center gap-3">
        <div class="bg-blue-600 p-2 rounded-lg">
          <svg class="w-6 h-6 text-white" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z"/>
          </svg>
        </div>
        <div>
          <h1 class="text-lg sm:text-xl font-bold tracking-tight">Directorio Telefónico Corporativo</h1>
          <p class="text-xs text-slate-400">Red interna verificada • Acceso seguro</p>
        </div>
      </div>
      <div class="flex items-center gap-2 self-start sm:self-auto">
        <span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
          <span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
          <span id="counterBadge">${directory.length} extensiones</span>
        </span>
      </div>
    </div>
  </header>

  <!-- CONTENIDO PRINCIPAL -->
  <main class="flex-1 max-w-6xl w-full mx-auto px-4 py-6">

    <!-- BARRA DE BÚSQUEDA Y FILTROS -->
    <div class="bg-white p-4 rounded-xl shadow-sm border border-slate-200 mb-6 grid grid-cols-1 md:grid-cols-3 gap-3">
      <div class="md:col-span-2 relative">
        <input
          type="text"
          id="searchInput"
          placeholder="Buscar por extensión, nombre o área..."
          autocomplete="off"
          class="w-full pl-10 pr-10 py-2.5 bg-slate-50 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:bg-white transition"
        />
        <svg class="w-5 h-5 text-slate-400 absolute left-3 top-2.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-4.35-4.35m0 0A7.5 7.5 0 104.5 4.5a7.5 7.5 0 0012.15 12.15z"/>
        </svg>
        <button
          id="clearBtn"
          type="button"
          class="hidden absolute right-3 top-2.5 text-slate-400 hover:text-slate-600 text-sm font-bold"
          title="Limpiar búsqueda"
        >✕</button>
      </div>

      <div>
        <select
          id="deptFilter"
          class="w-full py-2.5 px-3 bg-slate-50 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:bg-white transition"
        >
          <option value="">Todos los departamentos (${departments.length})</option>
          ${departments
            .map((dept) => `<option value="${escapeHTML(dept)}">${escapeHTML(dept)}</option>`)
            .join("")}
        </select>
      </div>
    </div>

    <!-- ESTADO VACÍO -->
    <div id="emptyState" class="hidden bg-white rounded-xl border border-slate-200 p-10 text-center">
      <p class="text-slate-500 font-medium">No se encontraron extensiones que coincidan con tu búsqueda.</p>
      <button id="resetFiltersBtn" class="mt-3 text-sm text-blue-600 hover:underline font-medium">
        Restablecer filtros
      </button>
    </div>

    <!-- VISTA MÓVIL (TARJETAS TÁCTILES) -->
    <div id="mobileCards" class="grid grid-cols-1 gap-3 md:hidden"></div>

    <!-- VISTA ESCRITORIO (TABLA DE DATOS) -->
    <div id="desktopTableWrapper" class="hidden md:block bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
      <table class="w-full text-left border-collapse">
        <thead>
          <tr class="bg-slate-100 border-b border-slate-200 text-xs font-semibold uppercase tracking-wider text-slate-600">
            <th class="py-3.5 px-4 w-32">Extensión</th>
            <th class="py-3.5 px-4">Nombre / Colaborador</th>
            <th class="py-3.5 px-4">Departamento</th>
            <th class="py-3.5 px-4">Notas / Correo</th>
            <th class="py-3.5 px-4 text-right w-28">Acción</th>
          </tr>
        </thead>
        <tbody id="desktopTableBody" class="divide-y divide-slate-100 text-sm"></tbody>
      </table>
    </div>
  </main>

  <!-- TOAST DE COPIADO -->
  <div id="toast" class="fixed bottom-5 right-5 bg-slate-900 text-white text-xs font-medium px-4 py-2.5 rounded-lg shadow-lg opacity-0 pointer-events-none transition-opacity duration-200 z-50">
    Extensión copiada al portapapeles
  </div>

  <!-- PIE DE PÁGINA -->
  <footer class="bg-white border-t border-slate-200 mt-10">
    <div class="max-w-6xl mx-auto px-4 py-4 flex flex-col sm:flex-row items-center justify-between text-xs text-slate-500 gap-2">
      <div>Soporte TI • Directorio Telefónico Corporativo</div>
      <div>
        Sincronizado: <span class="font-medium text-slate-700">${escapeHTML(meta.lastUpdated)}</span>
        (Cache: ${escapeHTML(meta.cacheStatus)})
      </div>
    </div>
  </footer>

  <script>
    const DIRECTORY_DATA = ${safeJSON};

    const searchInput = document.getElementById("searchInput");
    const clearBtn = document.getElementById("clearBtn");
    const deptFilter = document.getElementById("deptFilter");
    const mobileCards = document.getElementById("mobileCards");
    const desktopTableBody = document.getElementById("desktopTableBody");
    const desktopTableWrapper = document.getElementById("desktopTableWrapper");
    const emptyState = document.getElementById("emptyState");
    const counterBadge = document.getElementById("counterBadge");
    const resetFiltersBtn = document.getElementById("resetFiltersBtn");
    const toast = document.getElementById("toast");

    function normalizeText(text) {
      return (text || "")
        .toString()
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\\u0300-\\u036f]/g, "");
    }

    function escapeClientHTML(str) {
      const div = document.createElement("div");
      div.textContent = str;
      return div.innerHTML;
    }

    function copyExt(ext) {
      navigator.clipboard.writeText(ext).then(() => {
        toast.textContent = "Extensión " + ext + " copiada";
        toast.classList.remove("opacity-0");
        setTimeout(() => toast.classList.add("opacity-0"), 2000);
      });
    }

    function renderResults() {
      const query = normalizeText(searchInput.value.trim());
      const selectedDept = deptFilter.value;

      clearBtn.classList.toggle("hidden", query.length === 0);

      const filtered = DIRECTORY_DATA.filter((item) => {
        const matchesDept = !selectedDept || item.department === selectedDept;
        if (!matchesDept) return false;
        if (!query) return true;

        const haystack = normalizeText(
          item.name + " " + item.extension + " " + item.department + " " + item.notes
        );
        return haystack.includes(query);
      });

      counterBadge.textContent = filtered.length + (filtered.length === 1 ? " extensión" : " extensiones");

      if (filtered.length === 0) {
        emptyState.classList.remove("hidden");
        mobileCards.innerHTML = "";
        desktopTableBody.innerHTML = "";
        desktopTableWrapper.classList.add("md:hidden");
        return;
      }

      emptyState.classList.add("hidden");
      desktopTableWrapper.classList.remove("md:hidden");

      // Render Móvil (Tarjetas)
      mobileCards.innerHTML = filtered
        .map((item) => {
          const ext = escapeClientHTML(item.extension);
          const name = escapeClientHTML(item.name);
          const dept = escapeClientHTML(item.department);
          const notes = escapeClientHTML(item.notes);
          return \`
            <div class="bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex items-center justify-between gap-3">
              <div class="min-w-0">
                <div class="font-semibold text-slate-900 truncate">\${name}</div>
                <div class="text-xs text-slate-500 mt-0.5">\${dept}\${notes ? " • " + notes : ""}</div>
              </div>
              <div class="flex items-center gap-2 shrink-0">
                <a href="tel:\${ext}" class="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white font-mono font-bold text-sm rounded-lg shadow-sm">
                  \${ext}
                </a>
                <button onclick="copyExt('\${ext}')" class="p-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-xs" title="Copiar">
                  📋
                </button>
              </div>
            </div>
          \`;
        })
        .join("");

      // Render Escritorio (Tabla)
      desktopTableBody.innerHTML = filtered
        .map((item) => {
          const ext = escapeClientHTML(item.extension);
          const name = escapeClientHTML(item.name);
          const dept = escapeClientHTML(item.department);
          const notes = escapeClientHTML(item.notes || "—");
          return \`
            <tr class="hover:bg-blue-50/50 transition">
              <td class="py-3 px-4">
                <span class="inline-block font-mono font-bold text-blue-700 bg-blue-50 border border-blue-200 px-2.5 py-1 rounded-md">
                  \${ext}
                </span>
              </td>
              <td class="py-3 px-4 font-medium text-slate-900">\${name}</td>
              <td class="py-3 px-4">
                <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-700">
                  \${dept}
                </span>
              </td>
              <td class="py-3 px-4 text-slate-500">\${notes}</td>
              <td class="py-3 px-4 text-right">
                <button
                  onclick="copyExt('\${ext}')"
                  class="px-2.5 py-1 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md transition"
                >
                  Copiar
                </button>
              </td>
            </tr>
          \`;
        })
        .join("");
    }

    searchInput.addEventListener("input", renderResults);
    deptFilter.addEventListener("change", renderResults);
    clearBtn.addEventListener("click", () => {
      searchInput.value = "";
      searchInput.focus();
      renderResults();
    });
    resetFiltersBtn.addEventListener("click", () => {
      searchInput.value = "";
      deptFilter.value = "";
      renderResults();
    });

    // Inicializar vista
    renderResults();
  </script>
</body>
</html>`;
}
