// The same work, written different ways (English, French, Kinyarwanda, short forms) — one place, used by Smart match and the CV studio search.
module.exports = (() => {
  const norm = t => String(t || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ');
  const STOP = new Set('and or of the a an for in at to with de et la le du des senior junior assistant head chief lead trainee intern officer staff worker'.split(' '));
  // the same job, written different ways (English, French, Kinyarwanda, short forms)
  const SYN = [['waiter', 'waitress', 'server', 'serveur', 'serveuse', 'umuseriveri'], ['cleaner', 'cleaning', 'housekeeper', 'housekeeping', 'menage', 'nettoyage', 'umukozi wo mu rugo'],
    ['guard', 'security', 'securite', 'gardien', 'umuzamu'], ['driver', 'chauffeur', 'umushoferi', 'motorist'], ['cook', 'chef', 'kitchen', 'cuisinier', 'umutetsi'], ['receptionist', 'reception', 'front desk', 'receptionniste'],
    ['accountant', 'accounting', 'comptable', 'finance', 'bookkeeper'], ['cashier', 'caissier', 'caissiere', 'till'], ['barista', 'bartender', 'barman', 'bar'], ['nurse', 'infirmier', 'infirmiere', 'caregiver', 'care'],
    ['nanny', 'babysitter', 'childcare', 'umurezi'], ['sales', 'seller', 'vendeur', 'vendeuse', 'marketing', 'commercial'], ['teacher', 'enseignant', 'tutor', 'mwarimu'], ['mason', 'builder', 'construction', 'macon', 'umufundi'],
    ['electrician', 'electricien'], ['plumber', 'plombier'], ['it', 'computer', 'technician', 'developer', 'informatique'], ['secretary', 'secretaire', 'admin', 'administrative', 'office'], ['storekeeper', 'store', 'warehouse', 'magasinier', 'stock'],
    ['gardener', 'jardinier', 'garden'], ['tailor', 'couturier', 'umudozi'], ['hairdresser', 'salon', 'coiffeur', 'coiffeuse', 'beauty'], ['mechanic', 'mecanicien', 'garage'], ['delivery', 'rider', 'motard', 'courier']];
  const GROUP = {}; SYN.forEach((g, i) => g.forEach(w => { GROUP[w] = 'g' + i; }));
  const toks = t => { const n = norm(t), out = new Set(); for (const [w, g] of Object.entries(GROUP)) if (w.includes(' ') && n.includes(w)) out.add(g);
    n.split(/\s+/).filter(w => w.length > 1 && !STOP.has(w)).forEach(w => out.add(GROUP[w] || GROUP[w.replace(/s$/, '')] || w.replace(/s$/, ''))); return out; };
  const overlap = (a, b) => { let n = 0; for (const x of a) if (b.has(x)) n++; return a.size ? n / a.size : 0; };

  return { toks, overlap, norm };
})();
