import { XMLParser } from "fast-xml-parser";

const XML_SOURCE_URL = "https://360net-publico.s3.amazonaws.com/phonebook.xml";

export default {
  async fetch(request, env, ctx) {
    const clientIP = (request.headers.get("CF-Connecting-IP") || "").trim();
    const allowedRaw = env.ALLOWED_IPS || "";
    const allowedList = allowedRaw
      .split(",")
      .map((ip) => ip.trim())
      .filter(Boolean);

    if (!isIPAllowed(clientIP, allowedList)) {
      return new Response(renderAccessDenied(clientIP), {
        status: 403,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    const cacheTTL = parseInt(env.CACHE_TTL || "1800", 10);
    const cache = caches.default;
    const cacheKey = new Request(XML_SOURCE_URL, { method: "GET" });

    let xmlResponse = await cache.match(cacheKey);

    if (!xmlResponse) {
      const originResponse = await fetch(XML_SOURCE_URL);
      if (!originResponse.ok) {
        return new Response("Error al obtener el directorio telefónico desde S3.", {
          status: 502,
        });
      }
      const xmlText = await originResponse.text();
      xmlResponse = new Response(xmlText, {
        headers: {
          "Content-Type": "application/xml; charset=utf-8",
          "Cache-Control": `public, max-age=${cacheTTL}`,
        },
      });
      ctx.waitUntil(cache.put(cacheKey, xmlResponse.clone()));
    }

    const xmlData = await xmlResponse.text();
    const contacts = parseAndSortContacts(xmlData);

    return new Response(renderApp(contacts), {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  },
};

function isIPAllowed(clientIP, allowedList) {
  if (!clientIP || allowedList.length === 0) return false;

  for (const entry of allowedList) {
    if (entry === clientIP) return true;

    if (entry.includes("/")) {
      if (clientIP.includes(":") && entry.includes(":")) {
        if (matchCIDRv6(clientIP, entry)) return true;
      } else if (!clientIP.includes(":") && !entry.includes(":")) {
        if (matchCIDRv4(clientIP, entry)) return true;
      }
    }
  }
  return false;
}

function matchCIDRv4(ip, cidr) {
  const [range, bitsStr] = cidr.split("/");
  const bits = parseInt(bitsStr, 10);
  if (isNaN(bits) || bits < 0 || bits > 32) return false;

  const ipNum = ip.split(".").reduce((acc, oct) => (acc << 8) + parseInt(oct, 10), 0) >>> 0;
  const rangeNum = range.split(".").reduce((acc, oct) => (acc << 8) + parseInt(oct, 10), 0) >>> 0;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;

  return (ipNum & mask) === (rangeNum & mask);
}

function expandIPv6(ip) {
  const parts = ip.split("::");
  let head = parts[0] ? parts[0].split(":") : [];
  let tail = parts[1] ? parts[1].split(":") : [];
  const missing = 8 - (head.length + tail.length);
  const full = [...head, ...Array(Math.max(0, missing)).fill("0"), ...tail];
  return full.map((h) => h.padStart(4, "0")).join("");
}

function matchCIDRv6(ip, cidr) {
  const [range, bitsStr] = cidr.split("/");
  const bits = parseInt(bitsStr, 10);
  if (isNaN(bits) || bits < 0 || bits > 128) return false;

  const ipBin = BigInt("0x" + expandIPv6(ip));
  const rangeBin = BigInt("0x" + expandIPv6(range));
  const shift = BigInt(128 - bits);

  return (ipBin >> shift) === (rangeBin >> shift);
}

/**
 * Parser ultra-flexible: busca nodos de contacto sin importar mayúsculas, minúsculas o nombres de etiquetas
 */
function parseAndSortContacts(xmlText) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    trimValues: true,
  });

  const parsed = parser.parse(xmlText);
  let rawContacts = [];

  // Función recursiva para encontrar cualquier lista de elementos que parezcan contactos
  function findContactsRecursive(obj) {
    if (!obj || typeof obj !== "object") return;
    for (const key of Object.keys(obj)) {
      const val = obj[key];
      if (key.toLowerCase() === "contact" || key.toLowerCase() === "entry") {
        if (Array.isArray(val)) {
          rawContacts.push(...val);
        } else {
          rawContacts.push(val);
        }
      } else if (typeof val === "object") {
        findContactsRecursive(val);
      }
    }
  }

  findContactsRecursive(parsed);

  const knownLocations = ["calabozo", "cagua", "maracay", "guarico", "barbacoa", "valle", "pascua", "socorro", "mercedes"];

  const contacts = rawContacts
    .map((c) => {
      // Extraer nombre de cualquier variante de etiqueta
      const rawName = String(c.FirstName || c.firstname || c.Name || c.name || "").trim();
      const rawLast = String(c.LastName || c.lastname || c.SurName || "").trim();
      const fullName = rawLast ? `${rawName} ${rawLast}`.trim() : rawName;

      // Extraer número de teléfono/extensión de cualquier variante
      let extension = "";
      const phoneNode = c.Phone || c.phone || c.Telephone || c.telephone || c.Number || c.number;
      
      if (typeof phoneNode === "string" || typeof phoneNode === "number") {
        extension = String(phoneNode).trim();
      } else if (Array.isArray(phoneNode)) {
        const pObj = phoneNode[0];
        extension = String(pObj?.phonenumber || pObj?.number || pObj?._ || pObj || "").trim();
      } else if (phoneNode && typeof phoneNode === "object") {
        extension = String(phoneNode.phonenumber || phoneNode.number || phoneNode._ || "").trim();
      }

      if (!fullName || !extension) return null;

      // 1. Detectar Colas de Llamadas (Q ...)
      if (/^Q\s+/i.test(fullName)) {
        const cleanQueueName = fullName.replace(/^Q\s+/i, "").trim();
        return {
          name: cleanQueueName,
          originalName: fullName,
          extension,
          location: "Principales",
          department: "Extensiones Principales",
          isQueue: true,
        };
      }

      const parts = fullName.split(/\s+/);
      let personName = fullName;
      let location = "General";
      let department = "General";

      if (parts.length >= 3) {
        personName = `${parts[0]} ${parts[1]}`;
        const thirdTerm = parts[2];
        const restOfText = parts.slice(3).join(" ");

        if (knownLocations.includes(thirdTerm.toLowerCase()) || /^L\d+$/i.test(thirdTerm)) {
          location = capitalizeWords(thirdTerm);
          department = restOfText ? capitalizeWords(restOfText) : "General";
        } else {
          location = capitalizeWords(thirdTerm);
          department = restOfText ? capitalizeWords(restOfText) : "General";
        }
      } else if (parts.length === 2) {
        personName = fullName;
        location = "General";
        department = "General";
      }

      return {
        name: personName,
        originalName: fullName,
        extension,
        location,
        department,
        isQueue: false,
      };
    })
    .filter(Boolean);

  return contacts;
}

function capitalizeWords(str) {
  return str
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function escapeHTML(str) {
  return String(str)
    .replace(/&/g, "&")
    .replace(/</g, "<")
    .replace(/>/g, ">")
    .replace(/"/g, '"');
}

function renderAccessDenied(clientIP) {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Acceso Denegado (403)</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen flex items-center justify-center p-4">
  <div class="max-w-md w-full bg-slate-900 border border-red-900/50 rounded-2xl p-8 text-center shadow-2xl">
    <div class="w-16 h-16 bg-amber-500/10 border border-amber-500/30 rounded-2xl flex items-center justify-center mx-auto mb-5 text-3xl">
      🔒
    </div>
    <h1 class="text-2xl font-bold text-white mb-2">Acceso Denegado (403)</h1>
    <p class="text-slate-400 text-sm mb-6">
      Este directorio telefónico es de uso exclusivo para las redes internas autorizadas de la oficina.
    </p>
    <div class="bg-slate-950 border border-slate-800 rounded-xl p-3 font-mono text-xs text-slate-300 break-all">
      IP detectada: <span class="text-red-400 font-semibold">${escapeHTML(clientIP || "Desconocida")}</span>
    </div>
  </div>
</body>
</html>`;
}

function renderApp(contacts) {
  const locations = Array.from(new Set(contacts.map((c) => c.location))).sort((a, b) => {
    if (a === "Principales") return -1;
    if (b === "Principales") return 1;
    return a.localeCompare(b, "es");
  });

  const departments = Array.from(new Set(contacts.map((c) => c.department))).sort((a, b) => {
    if (a === "Extensiones Principales") return -1;
    if (b === "Extensiones Principales") return 1;
    return a.localeCompare(b, "es");
  });

  const contactsJSON = JSON.stringify(contacts).replace(/</g, "\\u003c");

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Directorio Telefónico Corporativo</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-100 text-slate-800 min-h-screen">
  <header class="bg-slate-900 text-white shadow-lg sticky top-0 z-20">
    <div class="max-w-4xl mx-auto px-4 py-4 flex items-center justify-between">
      <div class="flex items-center gap-3">
        <div class="w-10 h-10 bg-blue-600 rounded-xl flex items-center justify-center shadow-inner">
          <svg class="w-5 h-5 text-white" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z"/>
          </svg>
        </div>
        <div>
          <h1 class="font-bold text-lg leading-tight">Directorio Telefónico Corporativo</h1>
          <p class="text-xs text-slate-400">Red interna verificada • Acceso seguro</p>
        </div>
      </div>
      <div class="flex items-center gap-2">
        <button id="viewToggleBtn" onclick="toggleViewMode()" class="bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium px-3 py-1.5 rounded-xl border border-slate-700 transition-colors flex items-center gap-1.5">
          <span id="viewIcon">📋</span> <span id="viewText">Vista Minimalista</span>
        </button>
        <span id="counterBadge" class="text-xs font-medium bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 px-3 py-1 rounded-full hidden sm:inline-block">
          ${contacts.length} ext
        </span>
      </div>
    </div>
  </header>

  <main class="max-w-4xl mx-auto px-4 py-6">
    <div class="bg-white rounded-2xl shadow-sm border border-slate-200 p-4 mb-6 space-y-3">
      <div class="relative">
        <span class="absolute inset-y-0 left-0 pl-3.5 flex items-center text-slate-400">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-4.35-4.35m0 0A7.5 7.5 0 1010.5 18a7.5 7.5 0 006.15-3.35z"/>
          </svg>
        </span>
        <input
          id="searchInput"
          type="text"
          placeholder="Buscar por extensión, nombre, ubicación o departamento..."
          class="w-full pl-11 pr-10 py-2.5 bg-slate-50 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
        />
        <button id="clearSearch" class="hidden absolute inset-y-0 right-0 pr-3 flex items-center text-slate-400 hover:text-slate-600">
          ✕
        </button>
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label class="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">Ubicación / Sede</label>
          <select id="locationFilter" class="w-full px-3 py-2 bg-slate-50 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
            <option value="">Todas las ubicaciones (${locations.length})</option>
            ${locations.map((loc) => `<option value="${escapeHTML(loc)}">${escapeHTML(loc === "Principales" ? "★ Extensiones Principales" : loc)}</option>`).join("")}
          </select>
        </div>

        <div>
          <label class="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">Departamento / Área</label>
          <select id="deptFilter" class="w-full px-3 py-2 bg-slate-50 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
            <option value="">Todos los departamentos (${departments.length})</option>
            ${departments.map((dept) => `<option value="${escapeHTML(dept)}">${escapeHTML(dept)}</option>`).join("")}
          </select>
        </div>
      </div>
    </div>

    <div id="resultsContainer"></div>
  </main>

  <div id="toast" class="fixed bottom-5 right-5 bg-slate-900 text-white text-xs font-medium px-4 py-2.5 rounded-xl shadow-lg opacity-0 pointer-events-none transition-opacity duration-200">
    Extensión copiada al portapapeles
  </div>

  <script>
    const CONTACTS = ${contactsJSON};
    let isMinimalView = false;

    const searchInput = document.getElementById("searchInput");
    const clearSearch = document.getElementById("clearSearch");
    const locationFilter = document.getElementById("locationFilter");
    const deptFilter = document.getElementById("deptFilter");
    const resultsContainer = document.getElementById("resultsContainer");
    const counterBadge = document.getElementById("counterBadge");
    const toast = document.getElementById("toast");
    const viewIcon = document.getElementById("viewIcon");
    const viewText = document.getElementById("viewText");

    function normalizeText(text) {
      return String(text || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\\u0300-\\u036f]/g, "");
    }

    function toggleViewMode() {
      isMinimalView = !isMinimalView;
      if (isMinimalView) {
        viewIcon.textContent = "📑";
        viewText.textContent = "Vista Tarjetas";
      } else {
        viewIcon.textContent = "📋";
        viewText.textContent = "Vista Minimalista";
      }
      renderList();
    }

    function copyExt(ext) {
      navigator.clipboard.writeText(ext).then(() => {
        toast.textContent = "Extensión " + ext + " copiada";
        toast.classList.remove("opacity-0");
        setTimeout(() => toast.classList.add("opacity-0"), 1800);
      });
    }

    function renderList() {
      const q = normalizeText(searchInput.value.trim());
      const selectedLoc = locationFilter.value;
      const selectedDept = deptFilter.value;

      clearSearch.classList.toggle("hidden", !q);

      let filtered = CONTACTS.filter((c) => {
        if (selectedLoc && c.location !== selectedLoc) return false;
        if (selectedDept && c.department !== selectedDept) return false;
        if (!q) return true;

        const haystack = normalizeText(
          c.originalName + " " + c.name + " " + c.extension + " " + c.location + " " + c.department
        );
        return haystack.includes(q);
      });

      filtered.sort((a, b) => {
        if (isMinimalView) {
          return a.name.localeCompare(b.name, "es", { sensitivity: "base" });
        } else {
          if (a.isQueue && !b.isQueue) return -1;
          if (!a.isQueue && b.isQueue) return 1;
          if (a.location !== b.location) return a.location.localeCompare(b.location, "es");
          if (a.department !== b.department) return a.department.localeCompare(b.department, "es");
          return a.name.localeCompare(b.name, "es", { sensitivity: "base" });
        }
      });

      counterBadge.textContent = filtered.length + (filtered.length === 1 ? " ext" : " ext");

      if (filtered.length === 0) {
        resultsContainer.innerHTML = \`
          <div class="bg-white rounded-2xl border border-slate-200 p-10 text-center text-slate-500 text-sm">
            No se encontraron extensiones con los filtros aplicados.
          </div>\`;
        return;
      }

      if (isMinimalView) {
        resultsContainer.innerHTML = \`
          <div class="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
            <table class="w-full text-left border-collapse">
              <thead>
                <tr class="bg-slate-50 border-b border-slate-200 text-slate-500 text-[11px] uppercase tracking-wider">
                  <th class="py-3 px-4 font-semibold">Extensión</th>
                  <th class="py-3 px-4 font-semibold">Nombre / Contacto</th>
                  <th class="py-3 px-4 font-semibold hidden sm:table-cell">Ubicación</th>
                  <th class="py-3 px-4 font-semibold text-right">Acción</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-slate-100 text-sm">
                \${filtered.map((c) => \`
                  <tr class="hover:bg-slate-50/80 transition-colors">
                    <td class="py-3 px-4 font-mono font-bold text-blue-600">\${escapeClient(c.extension)}</td>
                    <td class="py-3 px-4 font-medium text-slate-900">\${escapeClient(c.name)}</td>
                    <td class="py-3 px-4 text-slate-500 hidden sm:table-cell">\${escapeClient(c.location)}</td>
                    <td class="py-3 px-4 text-right">
                      <div class="inline-flex items-center gap-1.5">
                        <a href="tel:\${escapeClient(c.extension)}" class="bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold px-2.5 py-1 rounded-lg">Llamar</a>
                        <button onclick="copyExt('\${escapeClient(c.extension)}')" class="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg border border-slate-200">📋</button>
                      </div>
                    </td>
                  </tr>\`).join("")}
              </tbody>
            </table>
          </div>\`;
      } else {
        resultsContainer.innerHTML = \`
          <div class="grid grid-cols-1