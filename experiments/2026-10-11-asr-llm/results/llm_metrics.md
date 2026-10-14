# Faza 3b — slijepa ocjena članaka (14 epizoda)

Ocjenjivač: Opus subagent po epizodi, kandidati anonimizirani A–E (nasumičan poredak po epizodi, `judge_prep.js`),
upute `judge_prompt.md`. Ulaz za sve modele isti: Speechmatics Enhanced dijarizirani SRT. `produkcija-opus` = produkcijski
članak (drugi transkript: Speechmatics + Gemini refine), samo na 2 referentne epizode.

## Prosječne ocjene (1–10)

| model | n | utemeljenost | imena | pokrivenost | jezik | struktura | ukupno | prosj. rang | 1. mjesta | greške teške/srednje/lake |
|---|---|---|---|---|---|---|---|---|---|---|
| produkcija-opus | 2 | 8.0 | 8.0 | 10.0 | 9.0 | 9.0 | 8.5 | 1.5 | 1 | 0/4/9 |
| gemini-4-argon | 14 | 7.5 | 7.6 | 8.9 | 8.4 | 8.6 | 7.5 | 1.6 | 8 | 8/20/59 |
| sonnet-5-5 | 14 | 8.0 | 6.9 | 9.7 | 7.2 | 7.4 | 7.3 | 1.9 | 5 | 0/38/56 |
| gemini-3-8-flash | 14 | 6.6 | 6.8 | 6.6 | 7.8 | 7.8 | 6.2 | 2.9 | 0 | 6/45/55 |
| haiku-5-5 | 14 | 4.3 | 4.6 | 6.7 | 5.8 | 4.4 | 3.6 | 4.1 | 0 | 24/98/44 |

## Trošak i pouzdanost (svi pozivi faze 2, uklj. probu)

| model | ep | pozivi | greške poziva | ulaz Mtok | izlaz ktok | 💭 ktok | $ ukupno | $/ep | s/poziv | JSON strogo na 1. pokušaj | JSON blago |
|---|---|---|---|---|---|---|---|---|---|---|---|
| gemini-3-8-flash | 14 | 78 | 0 | 3.35 | 254 | 236 | 4.35 | 0.311 | 47 | 78/78 | 78/78 |
| gemini-4-argon | 14 | 76 | 0 | 3.28 | 344 | 0 | 10.00 | 0.714 | 37 | 76/76 | 76/76 |
| haiku-5-5 | 14 | 79 | 0 | 4.46 | 805 | 0 | 1.64 | 0.117 | 46 | 46/79 | 79/79 |
| sonnet-5-5 | 14 | 79 | 0 | 4.49 | 1262 | 0 | 29.98 | 2.142 | 107 | 30/79 | 79/79 |

Napomene: Sonnet $ je ekvivalent (pretplata, `total_cost_usd` iz CLI-ja). Anthropic ne odvaja razmišljanje od izlaza
(💭 = samo Gemini `thoughtsTokenCount`). Claude tokenizer broji ~1,5× više tokena za isti hrvatski tekst.

## Po epizodi (ukupna ocjena)

| epizoda | produkcija-opus | gemini-4-argon | sonnet-5-5 | gemini-3-8-flash | haiku-5-5 | rang |
|---|---|---|---|---|---|---|
| PlPyI-TPlgw | — | 8 | 7 | 6 | 5 | gemini-4-argon > sonnet-5-5 > gemini-3-8-flash > haiku-5-5 |
| dK_cN6D3dDQ | — | 8 | 9 | 6 | 5 | sonnet-5-5 > gemini-4-argon > gemini-3-8-flash > haiku-5-5 |
| PFeTdbx-09c | — | 7 | 8 | 6 | 4 | sonnet-5-5 > gemini-4-argon > gemini-3-8-flash > haiku-5-5 |
| Y89lSaTRAqQ | — | 5 | 8 | 7 | 4 | sonnet-5-5 > gemini-3-8-flash > gemini-4-argon > haiku-5-5 |
| wXPHSvY9Cek | — | 8 | 7 | 6 | 3 | gemini-4-argon > sonnet-5-5 > gemini-3-8-flash > haiku-5-5 |
| -P5TCG_aN2c | 9 | 6 | 8 | 7 | 4 | produkcija-opus > sonnet-5-5 > gemini-3-8-flash > gemini-4-argon > haiku-5-5 |
| O72WoKYazQ0 | — | 6 | 7 | 5 | 3 | sonnet-5-5 > gemini-4-argon > gemini-3-8-flash > haiku-5-5 |
| IBKliva4oYk | — | 8 | 5 | 6 | 2 | gemini-4-argon > gemini-3-8-flash > sonnet-5-5 > haiku-5-5 |
| ja995FNQP3A | 8 | 9 | 7 | 6 | 4 | gemini-4-argon > produkcija-opus > sonnet-5-5 > gemini-3-8-flash > haiku-5-5 |
| 2FeLIaMDprw | — | 7 | 8 | 6 | 4 | sonnet-5-5 > gemini-4-argon > gemini-3-8-flash > haiku-5-5 |
| soQ8jSlBT1Y | — | 8 | 7 | 6 | 5 | gemini-4-argon > sonnet-5-5 > gemini-3-8-flash > haiku-5-5 |
| 4s5SI-n7270 | — | 8 | 7 | 6 | 2 | gemini-4-argon > sonnet-5-5 > gemini-3-8-flash > haiku-5-5 |
| v6QdSjd8NAE | — | 8 | 6 | 7 | 3 | gemini-4-argon > gemini-3-8-flash > sonnet-5-5 > haiku-5-5 |
| IjoWv3AmbvA | — | 9 | 8 | 7 | 3 | gemini-4-argon > sonnet-5-5 > gemini-3-8-flash > haiku-5-5 |

## Teške greške

### produkcija-opus (0)


### gemini-4-argon (8)

- **Y89lSaTRAqQ** [halucinacija] Izmišljen suparnik i Durdovljeva ocjena o njemu. — „nastavlja se utakmicama protiv Slaven Belupa, Nantesa i Rijeke ... izrazio je veliku skepsu uoči okršaja s francuskim Nantesom" (transkript: 01:07:14–01:07:58 Durdov ne imenuje treći suparnik ('za koji tek. Nemam blage veze'))
- **Y89lSaTRAqQ** [halucinacija] Reprezentativna utakmica sa Španjolskom pretvorena je u Hajdukovu protiv Villarreala. — „Granić se prisjetio prvih 30 minuta utakmice protiv Villarreala" (transkript: 01:02:58 'Bili smo Renata i Luka na utakmici sa Španjolskom. Prvih 30 minuta')
- **Y89lSaTRAqQ** [halucinacija] Izmišljena izjava s imenima kojih u tom dijelu nema. — „sredina terena s Pajazitijem, Del Moralom i Pukštasom morati odigrati besprijekorno" (transkript: 01:02:15–01:04:34 Vujić ne spominje te igrače ni takvu tezu)
- **O72WoKYazQ0** [krivo_ime] Kod Dinamova gola izletio je Marušić, ne Mardešić. Ista zamjena ponavlja se kod grafike (00:13) i kod guranja Belje (00:22: 'Marušić odgurao'). — „nakon čega je stoper **Mardešić** nepotrebno iskočio prema naprijed" (transkript: 00:17:xx Mate: 'Kapanje je spojio, a Marušić je odlučio da će i on izletjeti.')
- **O72WoKYazQ0** [krivo_ime] Izmišljeno ime; prema transkriptu (i popisu u A) riječ je o Hadžikaduniću. — „kao i **Hadžiahmetović** pred sam kraj" (transkript: 00:18:xx 'Hadži Madunić je u zadnjem udarcu glavom bija na njemu')
- **O72WoKYazQ0** [krivo_ime] U transkriptu je izričito Del Moral; Guillamón je izmišljen. — „utvrđuju da se **Guillamón** najslabije adaptirao na potop" (transkript: 01:39:xx Danko: 'kod nemorala jedna stvar. On se možda najslabije adaptirao na vaterpolo... To je del moral.')
- **O72WoKYazQ0** [halucinacija] Diallo se nigdje ne spominje; ime je izmišljeno. — „Posebno oduševljenje u studiju izazvao je povratak **Dialla** na teren." (transkript: 01:33:xx 'Lijepo je bilo vidjeti da je DK ušao u igru' + prethodno 'Katula, Martina')
- **4s5SI-n7270** [halucinacija] Ime Gascoigne nigdje se ne spominje; govornik izričito kaže da se ne sjeća imena. — „**Nestanak Paula Gascoignea:** Na treningu na pomoćnom terenu s malom tribinom i zidom iza kojeg se nalazila šuma, netko je nabio loptu preko ograde. Gascoigne " (transkript: 02:54:35 Vinko: 'Nije iz ovih naših... onog bivšeg ... suigrača kojem se isto ne mogu sjetiti imena')

### sonnet-5-5 (0)


### gemini-3-8-flash (6)

- **PlPyI-TPlgw** [jezik] Japanski znakovi usred hrvatske riječi u sažetku. — „Poseban nagラスak stavljen je" (transkript: -)
- **O72WoKYazQ0** [krivo_ime] Bambin čuvar je lijevi bek (Perez/'Willow'); Pierre-Gabriel se u transkriptu ne spominje. — „ostavivši Bambi ogroman prostor u kojemu je Pierre-Gabriel doslovno izgubio kompas" (transkript: 00:50:04 Danko: 'Ja mislim da je Willow kompas vadio da se snađe' (Willow/Perez = Dinamov lijevi bek))
- **O72WoKYazQ0** [krivo_ime] Prezime Baturina izmišljeno; u transkriptu je 'Katula'. — „status Martina Baturine, odnosno Martina koji tek treba uhvatiti kontinuitet" (transkript: 01:33:xx 'Što se tiče Katula, Martina, kako ga već svi Martin zove?')
- **IBKliva4oYk** [krivo_ime] Ime kojeg nema u transkriptu, a ne odgovara ni opisu (23 godine). — „nastupu Ronaëla Pierre-Gabriela" (transkript: 00:19:55-00:20:39 'Valentin', 'Valenčić', 'Tadinac' – 23-godišnji desni bek)
- **4s5SI-n7270** [jezik] Kineski znakovi usred riječi. — „No, prema Dubravi措inom sudu" (transkript: —)
- **4s5SI-n7270** [halucinacija] Gascoigne se nigdje ne spominje. — „Spominje se i slična priča o Paulu Gascoigneu koji je preskočio ogradu tražeći loptu i nestao na puna 24 sata" (transkript: 02:54:35 Vinko: 'suigrača kojem se isto ne mogu sjetiti imena')

### haiku-5-5 (24)

- **dK_cN6D3dDQ** [halucinacija] Bolnica je otvorena prije 18 godina, ne nakon 18 godina rada. — „Tek su nakon osamnaest godina odlučili voditi privatnu ustanovu" (transkript: 00:06:34 'Prije nego što su otvorili bolnicu prije osamnaest godina')
- **Y89lSaTRAqQ** [krivo_ime] Trener Dinama je proglašen desnim bekom. — „Kovačić na poziciji desnog beka ... Kovačić se ne može ocijeniti kao znatno lošiji od ostatka ekipe. Podsjeća da je igrač doveden s ciljem da bude rotacijski be" (transkript: 00:25:52 'rekao i Kovačić nakon utakmice da njemu [bek] bio OK' – Kovačić je trener)
- **Y89lSaTRAqQ** [krivo_pripisano] Racij je zamijenjen Hadžićem; cijeli odlomak opisuje krivog igrača. — „Duje Granić odgovara da je u ovom trenutku Hadžić prvi lijevi stoper" (transkript: 00:22:36 'što se tiče racija, meni je on u ovom trenutku prvi lijevi stoper')
- **Y89lSaTRAqQ** [halucinacija] Igrač koji nije igrao prikazan je kao da je podbacio na terenu. — „Mišić nije bio u stanju preuzeti takvu ulogu s istim rasponom dodavanja i kreacije" (transkript: 00:34:24 Mišić je izostao; 'nitko u ovoj ligi nije mišić' odnosi se na njegovu zamjenu)
- **wXPHSvY9Cek** [halucinacija] Opisi slika sustavno izmišljaju grafike, karte i natpise (i 'Revizionizam u povijesti', 'Prihvatilišta, a ne logori', portret Stepinca). — „na ekranu se prikazuje karta Kraljevine SHS s naznačenim razdobljem između dva rata" (transkript: 00:10:18 samo razgovor u studiju)
- **wXPHSvY9Cek** [struktura] Sadržaj iz 47.–52. minute stavljen je u prvi dio s krivim vremenima (00:34:35, 00:37:40), vremena slika idu unatrag (00:37:40 pa 00:35:34), a isti sadržaj ponavlja se u drugom dijelu. — „### Djeca s Kozare: prihvatilišta, dokumenti i spor oko „logora za djecu” *[slika 00:34:35 ...]*" (transkript: Prihvatilišta i Luburić: 00:49:17–00:51:59; Budisavljević: 00:47:23)
- **-P5TCG_aN2c** [halucinacija] Četvero djece, a ne troje; tekst proturječi sam sebi. — „majku troje djece (tri dječaka i jedne djevojčice)" (transkript: 00:00:44 'majku, tri dječaka i jedne djevojčice')
- **O72WoKYazQ0** [krivo_pripisano] Statistika momčadi pripisana Bambi. — „Bamba je, prema statistikama koje su sugovornici pregledali, u prvih dvadeset minuta drugog poluvremena osvojio 14 od 17 duela" (transkript: 00:11:xx 'u prvih dvadeset minuta drugog poluvremena ima četrnaest od 17 duela osvojenih' (momčad, sredina terena))
- **IBKliva4oYk** [krivo_ime] Kroz cijeli članak voditelji su anonimni, iako je iz naslova i snimke jasno tko je Profa (01), a tko Denis (02). — „SPEAKER_01 = Voditelj 1 (voditelj); SPEAKER_02 = Voditelj 2 (voditelj)" (transkript: 00:24:15 'kad je Denis pustio'; 00:52:36 'Dobro Denisa'; naslov 'Denis&Profa')
- **IBKliva4oYk** [halucinacija] Rečenica je zamišljena (protučinjenična), a članak je pretvara u činjenicu, uz opis slike s 'golom Livaje'. — „Voditelj 1 dodaje da je Livaja postigao dva kvalitetna gola" (transkript: 00:26:18 'da nam je sad danas Livaja strpao dva majstorska gola' (hipotetski))
- **IBKliva4oYk** [halucinacija] Duje Čop nije igrao; članak mu pripisuje nastup, a Belju posve izostavlja. — „Voditelj 1 smatra da Čop nije bio uvjerljivo najbolji u utakmici, ali ga pohvaljuje za angažman." (transkript: 00:31:38-00:32:10 Čop se spominje samo kao povijesna usporedba; pohvala je bila za Belju)
- **IBKliva4oYk** [halucinacija] Momčad je zamijenjena. — „pa je moguće da je Dinamo trebao igrati s igračem manje" (transkript: 00:03:59 'vjerojatno je trebao Hajduk biti s igračem manje')
- **ja995FNQP3A** [struktura] Opisi slika izmišljaju kadrove kojih nema (prosvjedi, elektrana, grafikoni, police u trgovini); dvije slike na istom vremenu 00:23:42. — „*[slika 00:22:08: Nuklearna elektrana s rashladnim tornjevima; vizualni prikaz energetske opcije.]*" (transkript: snimka je studijski razgovor dvojice sugovornika)
- **2FeLIaMDprw** [halucinacija] 200 g u 2:42 je ~74 g/h, ne 120 g/h; brojke međusobno proturječne i krive. — „ukupni unos procijenio je na oko 120 grama ugljikohidrata po satu, odnosno oko 200 grama ukupno" (transkript: 01:05:04-01:05:44 120 g u bidonima + 5 gelova; 'u dva sata i 42. Oko 200 grama ugljikohidrata')
- **soQ8jSlBT1Y** [struktura] Cijeli odlomak pod slikom 00:50:06 ponavlja sadržaj Dijela 1 s krivim vremenom, a stvarni sadržaj tog dijela snimke izostaje. — „Preuzimanje odgovornosti za vlastiti život ... Kao primjer navodi vlasnika servisa koji nije skrivio pogrešku zaposlenika" (transkript: 00:21:29–00:22:54 (krivnja/odgovornost, servis, bogati roditelji, samoća); u 00:48–00:50 se govori o prevari, Star Wars )
- **4s5SI-n7270** [krivo_ime] Voditelj je Marjan, Frane je SPEAKER_03; cijeli članak pripisuje voditeljeve izjave Frani. — „**Govornici:** SPEAKER_00 = Frane (voditelj); SPEAKER_01 = Vinko (voditelj); SPEAKER_02 = Gost 2 (sugovornik); SPEAKER_03 = Gost 1 (sugovornik)" (transkript: 00:00:07 S0: 'Dobra večer, Vinko Dubravica i Frane'; S3 voditelja zove 'Marjane'; 02:03:01 S1 Frani: 'Ajde, Frane odmori)
- **4s5SI-n7270** [halucinacija] Livaja nije igrao; sugovornici traže da igra, nitko ne kritizira njegovu igru. — „**Frane** je kritičan prema Livajinoj igri u posljednjim utakmicama, navodeći da je propustio situacije koje bi ga trebale 'podići'." (transkript: 01:40:05–01:41:14 S3: Livaja 'nije bio na zagrijavanju'; 01:59:42 Marjan: 'utakmica mrtvo hladno za Livaju')
- **4s5SI-n7270** [halucinacija] Šego je napadač, raspravlja se o vrataru Siliću. — „Sugovornici raspravljaju o tome treba li zamijeniti vratara **Šega** ili ga zadržati zbog njegova iskustva." (transkript: 02:42:35 pitanje o Siliću; Šego je napadač (01:33:57 'asistenciju za bombu'))
- **v6QdSjd8NAE** [krivo_pripisano] Priču o majici Kiše metaka i acetonu priča splitski član Avangarde, ne Khan. — „osobnu priču voditelja **Khana**, koji se prisjeća svog dolaska u Zagreb 2013. godine... kupio je svoju prvu majicu" (transkript: 00:46:36 Khan: 'znam da si tad već pričao koliko si fan'; 00:46:55 gost: 'Čim sam došao u Zagreb 2013... kiša metaka... )
- **v6QdSjd8NAE** [krivo_pripisano] U Indiji je živio član Avangarde; Khan se tome čudi. — „Razgovor prelazi na osobnu priču Khana o životu i radu u Indiji" (transkript: 01:46:16 [SPEAKER_07] Khan: 'Uvijek mi je mit da si bio u Indiji')
- **v6QdSjd8NAE** [krivo_pripisano] Prvi nastup u Ljubljani je Avangardin. — „Khan se prisjeća da je ljubljanski nastup bio prvi koji je izveo u tom gradu" (transkript: 01:26:54 gost: 'To nam je prvi nastup u Ljubljani bio ozbiljno')
- **v6QdSjd8NAE** [krivo_pripisano] Koncert najavljuju gosti, Khan je postavio pitanje ('mala ptičica'). — „Khan najavljuje da bend planira veći koncert u klubu Vintage... Khan potvrđuje da je koncert u planu" (transkript: 01:38:19–01:39:00 gost: '11. drugog 2027... Vintage je u planu ne u planu, nego dogovoren')
- **v6QdSjd8NAE** [krivo_ime] SPEAKER_07 je Khan; članak izmišlja anonimnog 'Voditelja 2' kojem pripisuje Khanove izjave (beef, Vegas, karte). — „SPEAKER_07 = Voditelj 2 (sugovornik)" (transkript: 01:20:33 [SPEAKER_07] 'ako ću tipa ja raditi Real fest')
- **IjoWv3AmbvA** [krivo_ime] Ključna govornica ostaje anonimna u cijelom dijelu o HALMED-u, a sažetak je bilježi kao 'Gost 1'. — „Emisija prelazi na videoprilog u kojem gost 1 čita službeni upit" (transkript: 00:48:xx voditelj izričito govori o doktorici Almi Demirović; govornica se predstavlja kao osoba koja je pisala u ime Hr)

## Napomene ocjenjivača

- **PlPyI-TPlgw:** Transkript je kratak (28 min, dva govornika) i jasno dijariziran, ali ASR teško iskrivljuje vlastita imena i stručne pojmove: 'Filipom budućem', 'Šimunova' (Schliemannova), 'Liman', 'Hij i OS u Quick mladima' (Ios u Kikladima), 'Meše Smajlagić', 'Let 3. Oni' (Lestrigonci), 'Homerov lozi', 'lagune' (lakune), 'Luka Sobjeskog', 'esejom' (Odisejom), 'Salinas. Pryce', 'i sa koje' (vjerojatno Issa). Razlike među kandidatima uglavnom proizlaze iz toga koliko su ta mjesta ispravno rekonstruirali. Svi točno imenuju voditelja i gosta prema naslovu i pokrivaju snimku do kraja. Nijedan nema ozbiljnu izmišljenu izjavu, a najveće greške su krivi grob (Hios), pogrešno razriješena imena i izmišljeni opisi slika.
- **dK_cN6D3dDQ:** Svi kandidati ispravno prepoznaju govornike (SPEAKER_00 = Petra Podobnik, SPEAKER_01 = Ana Radišić) i Tomislava Kuljiša. Svi navode 'medicinsku direktoricu' i 'specijalisticu ginekologije'; to u transkriptu ne piše, vjerojatno potječe iz metapodataka. Transkript je kratak (35 min) i razumljiv. Glavne ASR zamke su naziv Kuljiševa centra ('PD centar studija IDPI'), bakina izreka ('dobiti kruh', vjerojatno 'kilu') i nejasna rečenica o tome je li humani porod 'nedohvatljiv' u drugim sustavima. Snimka počinje teaserom isječenim iz kasnijih dijelova (00:00–01:20), koji B ispravno označava kao najavu.
- **PFeTdbx-09c:** Transkript je ASR s puno šuma (Dayton=dating, Red Flege, nerazumljivi fragmenti oko šminke i Tome Akvinskog), a dijarizacija je mjestimice nepouzdana. Imena se mogu izvesti samo iz rijetkih usputnih spominjanja (Luka 00:13:59, Andrija 00:14:13, Marco 00:36:28), dok gošće ostaju neimenovane. Svi kandidati pogrešno ili nejasno prenose razmjenu kava/šetnja na 00:43:10, a svi pokrivaju snimku do kraja.
- **Y89lSaTRAqQ:** Transkript je vrlo šum (ASR): imena igrača su iskrivljena (Racij/'raskrižja', Hadžikadunić/'Hadžića Madunića', Ivanušec/'Ivanišević'/'Ivan Sušec', McKenna/'mecene', Kovačević/'Kovačić', Raków/'rakova'), a mnoge rečenice gube niječnicu ili smisao. Svi kandidati ispravno su imenovali četvoricu govornika. Razlikuju se po tome koliko su nadopunjavali iz vanjskog znanja: A i D najviše (D i s izmišljenim suparnicima i izjavama), C najmanje, a B je najviše griješio u tumačenju tko je tko. Nijedan kandidat nije pokazao puni naslov epizode osim naziva emisije, pa zapis imena igrača nije bilo moguće provjeriti prema naslovu.
- **wXPHSvY9Cek:** ASR transkript je loš (iskrivljena imena: 'Breezhaler', 'Beader', 'sina i sina, IRA je studio', 'U Italiji u Japanu', 'prodat će', 'ucijenili'), a voditelja se ne imenuje ni u jednom kandidatu (u snimci se ne predstavlja). B, C i D spominju 'TV Jadran', čega u snimci nema, pa to vjerojatno dolazi iz metapodataka. A i C pokrivaju snimku od početka do odjave i razlikuju voditeljeve od gostovih tvrdnji. B je kratak i ubacuje opće znanje, a D raspada strukturu i izmišlja vizualni sadržaj. A i B u članku pišu 'Dumbović', a C i D točno 'Dundović'.
- **-P5TCG_aN2c:** Svi kandidati točno su prepoznali govornike (SPEAKER_00 = Željka Markić, SPEAKER_01 = Andrea Piškor) i nijedan nije izmislio ime treće osobe. ASR transkript je vrlo šumovit: 'po Spartom' = postpartum, 'fizionomija/epizodom' = epiziotomija, 'šeširi' = šeširići, 'u biti' = vjerojatno 'u birtiji', 'iz 99' = 1999. Najviše grešaka nastaje upravo na tim mjestima. Četiri kandidata nazivaju gošću 'dulom', iako se u snimci govori samo 'pratiteljica'. B i E dodaju 'snahu' koje u izvoru nema. Svi pokrivaju snimku do kraja (kontakt i preporuke).
- **O72WoKYazQ0:** ASR transkript je vrlo loš u imenima (Willow/Pereza Windowsa = Perez Vinlöf, Hadži Madunić, 'nemoral' = Del Moral, 'jaka pandža', 'Katula', 'Šutić'), a naslov epizode ne pomaže. Zato se kandidati razlikuju ponajviše po tome kako postupaju s imenima: D ih ostavlja doslovno, A i posebno B ih 'popravljaju' znanjem izvan transkripta, dio točno (Vinlöf, Weghorst), a dio izmišljeno (Mardešić umjesto Marušića, Hadžiahmetović, Guillamón, Diallo, Pierre-Gabriel). Ime Šotiček (A, B) umjesto ASR-ovog 'Šutić' nije moguće provjeriti iz transkripta. Svi pokrivaju snimku do kraja, ali u trećem dijelu (pitanja gledatelja) dubinom prednjače B i D.
- **IBKliva4oYk:** Transkript je vrlo šumovit ASR (Hrvat iz hotelske sobe, preklapanja): imena su iskrivljena (Pirović = Jakirović, mecena = McKenna, Valentin/Tadinac = desni bek, tun = Thun, 'najsretnija' umjesto vjerojatno 'najsramotnija'). Kandidati se razlikuju upravo po tome razrješavaju li te šumove smisleno (A), preuzimaju ih doslovno (B), nadomještaju izmišljenim imenima (D) ili ih zaobilaze anonimizacijom i izmišljotinama (C). Svi pokrivaju snimku do kraja (01:04).
- **ja995FNQP3A:** Svi kandidati ispravno mapiraju govornike (SPEAKER_00 = gost Petar Šarić, SPEAKER_01 = voditelj). Svi navode voditelja kao 'Marin Marić'; u transkriptu se ime javlja samo kao ASR 'Marianne' (00:01:49, vjerojatno vokativ 'Marine'), a prezime se ne izgovara, pa se ne može provjeriti iz izvora (vjerojatno potječe iz metapodataka). Transkript ima mnogo ASR šuma u ključnim pojmovima (kontra arijanstvo = kontrarijanstvo, krovni kapitalizam = crony capitalism, popularnost svijeta = unipolarnost, Tim Diversity = Unity in diversity, Ontario jamstvo, mise u HR a) – razlika među kandidatima uglavnom je u tome koliko ga uspješno razrješavaju. B i D dijele grešku 'etničke' umjesto 'etičke' (00:50:45). Svi pokrivaju snimku do kraja (01:12:07); sva vremena slika unutar su snimke.
- **2FeLIaMDprw:** Svi su ispravno identificirali govornike (SPEAKER_00 = Josip, SPEAKER_01 = Luka Batur) i pokrili snimku do kraja (oko 01:44). ASR je jako loš upravo na imenima znanstvenika ('Ascari/Oscar' = Jeukendrup, 'Luis Borges' = Louise Burke), robnim markama i mjernim jedinicama ('120 osoba', 'gladan' umjesto 'gadan', 'oksidativni' umjesto 'laksativni', 'Readers Das Ist'), pa je svaki kandidat birao između opreznog izostavljanja (A, B) i rekonstrukcije iz vanjskog znanja (C, D). Rekonstrukcije su uglavnom uvjerljive, ali iz transkripta nisu provjerljive. Prezime 'Lukina' kod Marije (C, D, B u popisu) vjerojatno je ASR artefakt, ne prezime. Redni broj epizode u transkriptu je 16, a u naslovu #19.
- **soQ8jSlBT1Y:** Prezime voditelja (Sorić/Soric) ne pojavljuje se ni u transkriptu ni u naslovu (u transkriptu je samo 'Vedrana' u 01:10:38), pa ga svi kandidati preuzimaju iz izvora izvan snimke; zapis bez dijakritika vjerojatno je netočan, ali se ne može provjeriti. ASR je jako šuman (perlatori → 'prelature', DISC → 'po disku', 'Kolarić', Adore → 'a Dore', 'Fromm', 'Luka', 'Fakin voda'), a kandidati se razlikuju upravo po tome koliko ga pametno razrješavaju. Dijarizacija je uglavnom ispravna, uz nekoliko zamijenjenih kratkih replika (npr. 00:53:10 'Ali ja sam miran i ispunjen' označeno kao SPEAKER_00). Mjesto o '5 posto svjesnog' dvosmisleno je u ASR-u; A i D ga čitaju kao gostovu tezu, B i C kao demistifikaciju, što bolje odgovara rečenici 'To su gluposti'.
- **4s5SI-n7270:** ASR transkript (~3h08) jako kvari imena igrača (Madunić/Kadoić = Hadžikadunić, paraziti = Pajaziti, Bomba/Bambi = Bamba, Šutić = Šotiček?), pa kandidati koji ih dešifriraju vanjskim znanjem (B, D) zvuče bolje, ali i lakše izmišljaju (oba dodaju Gascoignea). Voditelj (Marjan) i Frane imenuju se samo usputno; C ih je zamijenio. SPEAKER_02 je zanemariv (30 fragmenata). Svi pokrivaju snimku do kraja; razlika je u preciznosti pripisivanja i u količini generičkog teksta.
- **v6QdSjd8NAE:** Transkript je težak: diarizacija razbija govornike na 20 oznaka, a SPEAKER_01 je na početku Khan, kasnije gost (Dejan), zato popis govornika ni kod koga nije pouzdan i to nisam kažnjavao. ASR kvari imena (Vending Hub, Domino's, Griselda, Burky/Burek, Custer, Loža/Lođa/Tereka) i kandidati ih različito pogađaju. A i B dijele isto nepotvrđeno ime studija 'Red Records' (vanjsko znanje). Svi pokrivaju snimku do odjave.
- **IjoWv3AmbvA:** ASR je vrlo loš u engleskim isječcima (Trump, social credit, AI lideri, Susan Dell): SPEAKER_14 i drugi spajaju više stranih govornika, pa su svi kandidati te dijelove morali rekonstruirati iz voditeljevih komentara. Ime voditelja (Filip) čuje se samo kroz obraćanja iz chata. Prijepis je dvosmislen kod brojke barela (izgovoreno '36. Koja cifra 3.6'), a B i C su izabrali krivu varijantu. Prezime liječnika 'trobojnicu' je ASR šum, iz kojeg su A i C izmislili puna imena. Svi pokrivaju snimku do odjave (02:42).
