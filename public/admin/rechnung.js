/* Rechnung als PDF im Backpack-Hero-Design (A4).
   Wird vom Admin erst beim Klick auf „Rechnung (PDF)“ geladen.
   bhRechnungPdf(L, fontkit, fonts, o, z) → Promise<Uint8Array>
     L       = PDFLib (pdf-lib)
     fontkit = @pdf-lib/fontkit oder null (dann Helvetica)
     fonts   = {reg, semi, bold} als ArrayBuffer (Archivo) oder null
     o       = Bestellung aus der Datenbank
     z       = {name, iban, bic, qr, ust}  qr = qrcode-Objekt (EPC) oder null */
(function(g){
  'use strict';
  var FIRMA = 'Backpack Hero Junior Company';
  var ADRESSE = ['HTL Vöcklabruck', 'Bahnhofstraße 42, 4840 Vöcklabruck'];
  var MAIL = 'info@backpackhero.at', WEB = 'backpackhero.at', IG = 'Instagram @backpackhero1';
  var JUNIOR = 'Junior Company ist ein Schulprojekt, dies ist daher keine Rechnung nach § 11 UStG, sie berechtigt den Käufer nicht zum Vorsteuerabzug!';
  var BEZAHLT = {bezahlt:1, versendet:1, abgeholt:1};

  function hex(L, h){ return L.rgb(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255); }
  function euro(c){ return (c / 100).toFixed(2).replace('.', ',') + ' €'; }
  function zwei(n){ return ('0' + n).slice(-2); }
  function datum(d){ return zwei(d.getDate()) + '.' + zwei(d.getMonth() + 1) + '.' + d.getFullYear(); }
  function fmtIban(i){ return String(i || '').replace(/\s+/g, '').toUpperCase().replace(/(.{4})/g, '$1 ').trim(); }
  function rr(x, y, w, h, r){ // abgerundetes Rechteck als SVG-Pfad (y nach unten)
    return 'M' + (x + r) + ' ' + y + 'H' + (x + w - r) + 'A' + r + ' ' + r + ' 0 0 1 ' + (x + w) + ' ' + (y + r) + 'V' + (y + h - r) + 'A' + r + ' ' + r + ' 0 0 1 ' + (x + w - r) + ' ' + (y + h) +
      'H' + (x + r) + 'A' + r + ' ' + r + ' 0 0 1 ' + x + ' ' + (y + h - r) + 'V' + (y + r) + 'A' + r + ' ' + r + ' 0 0 1 ' + (x + r) + ' ' + y + 'Z';
  }

  g.bhRechnungPdf = function(L, fontkit, fonts, o, z){
    return L.PDFDocument.create().then(function(doc){
      var eigene = !!(fontkit && fonts);
      if(eigene) doc.registerFontkit(fontkit);
      var laden = eigene
        ? [doc.embedFont(fonts.reg, {subset:true}), doc.embedFont(fonts.semi, {subset:true}), doc.embedFont(fonts.bold, {subset:true})]
        : [doc.embedFont(L.StandardFonts.Helvetica), doc.embedFont(L.StandardFonts.Helvetica), doc.embedFont(L.StandardFonts.HelveticaBold)];
      return Promise.all(laden).then(function(f){
        var REG = f[0], SEMI = f[1], BOLD = f[2];
        var pg = doc.addPage([595.28, 841.89]), W = pg.getWidth(), H = pg.getHeight();
        var DUNKEL = hex(L, '#15171A'), CREME = hex(L, '#F3F0E8'), LINIE = hex(L, '#D6D1C4'), GRAU = hex(L, '#55514A'), HELL = hex(L, '#F3F0E8');
        var ROT = hex(L, '#C8412F'), GELB = hex(L, '#E2B13C'), GRUEN = hex(L, '#2F7A4D'), WEISS = L.rgb(1, 1, 1);
        var M = 46, R = W - M; // Ränder

        // Zeichen, die die Schrift nicht hat, ohne Akzent schreiben
        function sauber(font, t){
          var fk = font.embedder && font.embedder.font;
          return Array.from(String(t == null ? '' : t)).map(function(ch){
            var ok = function(c){ if(fk && fk.hasGlyphForCodePoint) return fk.hasGlyphForCodePoint(c.codePointAt(0)); try { font.encodeText(c); return true; } catch(e){ return false; } };
            if(ch === ' ' || ok(ch)) return ch;
            var b = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
            return b && ok(b) ? b : '?';
          }).join('');
        }
        function breite(t, size, font, sp){ return font.widthOfTextAtSize(t, size) + (sp || 0) * Math.max(0, Array.from(t).length - 1); }
        // top = Grundlinie von oben gemessen; opt: size, font, color, maxW, align ('left'|'right'), sp (Buchstabenabstand)
        function text(t, x, top, opt){
          opt = opt || {}; var font = opt.font || REG, size = opt.size || 10, sp = opt.sp || 0;
          t = sauber(font, t); if(!t) return 0;
          while(opt.maxW && size > 6 && breite(t, size, font, sp) > opt.maxW) size -= 0.25;
          var w = breite(t, size, font, sp), x0 = opt.align === 'right' ? x - w : x;
          if(!sp) pg.drawText(t, {x:x0, y:H - top, size:size, font:font, color:opt.color || DUNKEL});
          else Array.from(t).forEach(function(ch){ pg.drawText(ch, {x:x0, y:H - top, size:size, font:font, color:opt.color || DUNKEL}); x0 += font.widthOfTextAtSize(ch, size) + sp; });
          return w;
        }
        function box(x, top, w, h, r, fill, rand){ pg.drawSvgPath(rr(0, 0, w, h, r), {x:x, y:H - top, color:fill || undefined, borderColor:rand || undefined, borderWidth:rand ? 0.75 : 0}); }
        function punkt(cx, cyTop, r, farbe){ pg.drawCircle({x:cx, y:H - cyTop, size:r, color:farbe}); }
        function linie(x1, x2, top){ pg.drawLine({start:{x:x1, y:H - top}, end:{x:x2, y:H - top}, thickness:0.75, color:LINIE}); }
        function feld(label, wert, x, top, w, opt){ text(label, x, top, {size:7.5, color:GRAU}); text(wert, x, top + 14, Object.assign({size:10, font:SEMI, maxW:w}, opt || {})); }

        var bezahlt = !!BEZAHLT[o.status];
        var versand = o.lieferart === 'Versand';
        var dt = new Date(o.created_at || Date.now());
        var frist = new Date(dt.getTime()); frist.setDate(frist.getDate() + 14);
        var zweck = 'Backpack Hero ' + o.nr;
        var summe = o.summe_cent, posCent = o.menge * o.einzelpreis_cent, vCent = versand ? (o.versand_cent || 0) : 0;

        // Hintergrund-Kreis oben rechts (wie am Flyer)
        pg.drawCircle({x:W - 20, y:H + 40, size:175, color:CREME});

        // Logo: Rucksack mit drei Trennern
        var lx = M, ly = 40, s = 0.62;
        pg.drawSvgPath('M24 14 V10 A8 8 0 0 1 40 10 V14', {x:lx, y:H - ly, scale:s, borderColor:DUNKEL, borderWidth:5});
        pg.drawSvgPath(rr(4, 14, 56, 62, 12), {x:lx, y:H - ly, scale:s, color:DUNKEL});
        [[16, ROT], [29.5, GRUEN], [43, GELB]].forEach(function(t){ pg.drawSvgPath(rr(t[0], 26, 5, 38, 1), {x:lx, y:H - ly, scale:s, color:t[1]}); });
        text('BACKPACK HERO', lx + 50, ly + 25, {size:15, font:BOLD, sp:0.9});
        text('JUNIOR COMPANY', lx + 50, ly + 38, {size:7, font:SEMI, color:GRAU, sp:2.8});

        // Titel rechts
        punkt(R - 40, 46, 3.6, ROT); punkt(R - 26, 46, 3.6, GELB); punkt(R - 12, 46, 3.6, GRUEN);
        text('Rechnung', R + 1, 84, {size:32, font:BOLD, align:'right'});

        // Empfänger
        var top = 132;
        text('RECHNUNG AN', M, top, {size:7.5, font:SEMI, color:GRAU, sp:1.3});
        // Langer Name: erst etwas kleiner, dann auf zwei Zeilen umbrechen
        var nm = sauber(BOLD, o.name), ns = 13, nz = [nm];
        while(ns > 11 && breite(nm, ns, BOLD) > 230) ns -= 0.5;
        if(breite(nm, ns, BOLD) > 230){
          var wo = nm.split(' '), a = '';
          while(wo.length > 1 && breite((a ? a + ' ' : '') + wo[0], ns, BOLD) <= 230) a = (a ? a + ' ' : '') + wo.shift();
          nz = a ? [a, wo.join(' ')] : [nm];
        }
        nz.forEach(function(t, i){ text(t, M, top + 20 + i * (ns + 3), {size:ns, font:BOLD, maxW:230}); });
        var zt = top + 36 + (nz.length - 1) * (ns + 3);
        var zeilen = [o.email];
        if(versand) zeilen.push(o.strasse, (o.plz + ' ' + o.ort).trim(), o.land);
        zeilen.filter(Boolean).forEach(function(t, i){ text(t, M, zt + i * 13, {size:9.5, color:GRAU, maxW:230}); });

        // Rechnungsdaten-Kasten
        var kx = 312, kw = R - kx, kt = top - 12;
        box(kx, kt, kw, 92, 12, WEISS, LINIE);
        feld('Rechnungsnummer', o.nr, kx + 14, kt + 22, 100, {font:BOLD, size:10.5});
        feld('Rechnungsdatum', datum(dt), kx + 128, kt + 22, 100, {font:BOLD, size:10.5});
        feld('Lieferart', versand ? 'Versand nach ' + (o.land || 'Österreich') : 'Abholung in der HTL Vöcklabruck', kx + 14, kt + 58, kw - 28);

        // Positionen
        var tt = 252, cM = M + 14, cA = M + 62, cE = R - 108, cG = R - 14;
        box(M, tt, R - M, 24, 9, DUNKEL);
        [['MENGE', cM, 'left'], ['ARTIKEL', cA, 'left'], ['EINZELPREIS', cE, 'right'], ['GESAMT', cG, 'right']].forEach(function(c){ text(c[0], c[1], tt + 15.5, {size:7.5, font:SEMI, color:HELL, sp:0.8, align:c[2]}); });
        var ry = tt + 24;
        text(String(o.menge), cM, ry + 23, {size:11, font:BOLD});
        text('Backpack Hero Rucksack-Organizer', cA, ry + 19, {size:10.5, font:BOLD, maxW:cE - cA - 70});
        text('Ampelsystem mit 3 Fächern: Rot, Gelb, Grün', cA, ry + 32, {size:8.5, color:GRAU});
        text(euro(o.einzelpreis_cent), cE, ry + 23, {size:10, align:'right'});
        text(euro(posCent), cG, ry + 23, {size:10, font:BOLD, align:'right'});
        ry += 44; linie(M, R, ry);
        if(vCent > 0){
          text('1', cM, ry + 21, {size:11, font:BOLD});
          text('Versand nach ' + (o.land || 'Österreich'), cA, ry + 21, {size:10.5, font:SEMI});
          text(euro(vCent), cE, ry + 21, {size:10, align:'right'});
          text(euro(vCent), cG, ry + 21, {size:10, font:BOLD, align:'right'});
          ry += 34; linie(M, R, ry);
        }

        // Summe
        var sw = 220, sx = R - sw, st = ry + 12, sh = z.ust ? 56 : 42;
        box(sx, st, sw, sh, 12, CREME);
        text('Gesamtbetrag', sx + 14, st + 26, {size:10, font:SEMI});
        text(euro(summe), R - 14, st + 28, {size:20, font:BOLD, align:'right'});
        if(z.ust){
          text('darin enthalten 20 % USt', sx + 14, st + 44, {size:8, color:GRAU});
          text(euro(Math.round(summe / 6)), R - 14, st + 44, {size:8, color:GRAU, align:'right'});
        }

        // Zahlung
        var pt = st + sh + 24, ph = bezahlt ? 104 : 140;
        box(M, pt, R - M, ph, 12, WEISS, LINIE);
        punkt(M + 18, pt + 20, 3, bezahlt ? GRUEN : GELB);
        text(bezahlt ? 'BEZAHLT. DANKE!' : 'ZAHLUNG', M + 27, pt + 23, {size:7.5, font:SEMI, color:bezahlt ? GRUEN : GRAU, sp:1.3});
        var mitQR = !bezahlt && z.qr, fx = M + 18, fw = (mitQR ? R - 130 : R - 18) - fx, c2 = fx + fw / 2;
        if(bezahlt){
          feld('Zahlungseingang', 'Der Betrag ist bei uns eingegangen.', fx, pt + 44, fw);
          feld('Verwendungszweck', zweck, fx, pt + 82, fw / 2 - 10);
          feld('Betrag', euro(summe), c2, pt + 82, fw / 2 - 10);
        } else {
          feld('Zahlungsart', versand ? 'Überweisung (Vorkasse)' : 'Überweisung oder bar bei der Abholung', fx, pt + 44, fw / 2 - 10);
          feld('Zahlbar bis', datum(frist), c2, pt + 44, fw / 2 - 10, {font:BOLD});
          feld('Verwendungszweck', zweck, fx, pt + 82, fw / 2 - 10);
          feld('Empfänger', z.name, c2, pt + 82, fw / 2 - 10);
          feld('IBAN' + (z.bic ? ' / BIC' : ''), fmtIban(z.iban) + (z.bic ? '   ' + String(z.bic).toUpperCase() : ''), fx, pt + 114, fw, {font:BOLD, size:11, sp:0.3});
        }
        if(mitQR){
          var n = z.qr.getModuleCount(), qs = 92, m = qs / (n + 2), qx = R - 18 - qs, qt = pt + 14;
          pg.drawRectangle({x:qx, y:H - qt - qs, width:qs, height:qs, color:WEISS});
          for(var r = 0; r < n; r++) for(var c = 0; c < n; c++) if(z.qr.isDark(r, c)) pg.drawRectangle({x:qx + (c + 1) * m, y:H - qt - (r + 2) * m, width:m + 0.02, height:m + 0.02, color:DUNKEL});
          text('Mit der Banking-App scannen', qx + qs / 2 - breite('Mit der Banking-App scannen', 6.5, REG) / 2, qt + qs + 9, {size:6.5, color:GRAU});
        }

        // Dank
        var dt2 = pt + ph + 40;
        text('Danke für deine Bestellung.', M, dt2, {size:19, font:BOLD});
        var x2 = M + text('Ordnung, die ', M, dt2 + 20, {size:11, font:BOLD});
        x2 += text('mitgeht', x2, dt2 + 20, {size:11, font:BOLD, color:GRUEN});
        text('.', x2, dt2 + 20, {size:11, font:BOLD, color:ROT});
        if(versand && !bezahlt) text('Wir schicken dein Paket los, sobald das Geld bei uns ist.', R, dt2 + 20, {size:8.5, color:GRAU, align:'right'});
        else text('Dein Backpack-Hero-Team', R, dt2 + 20, {size:8.5, color:GRAU, align:'right'});

        // Junior-Hinweis und Fußzeile (unten fixiert)
        var ft = H - 40 - 36;
        box(M, ft - 46, R - M, 30, 9, CREME);
        text(JUNIOR, M + 12, ft - 27.5, {size:7.6, font:SEMI, maxW:R - M - 24});
        linie(M, R, ft - 4);
        var spalte = (R - M) / 3;
        text(FIRMA, M, ft + 10, {size:7.5, font:BOLD});
        ADRESSE.forEach(function(t, i){ text(t, M, ft + 21 + i * 10, {size:7.5, color:GRAU}); });
        text(MAIL, M + spalte, ft + 10, {size:7.5, color:GRAU});
        text(WEB, M + spalte, ft + 21, {size:7.5, color:GRAU});
        text(IG, R, ft + 10, {size:7.5, color:GRAU, align:'right'});
        text('Ein Schulprojekt mit', R, ft + 21, {size:7.5, color:GRAU, align:'right'});
        text('Junior Achievement Austria', R, ft + 31, {size:7.5, color:GRAU, align:'right'});

        doc.setTitle('Rechnung ' + o.nr + ' ' + o.name);
        doc.setAuthor(FIRMA); doc.setCreator('backpackhero.at Admin'); doc.setLanguage('de-AT');
        return doc.save();
      });
    });
  };
})(typeof window !== 'undefined' ? window : globalThis);
