# Katolički mediji — analiza playlista (14.10.2026.)

Povod: prijedlog za HKM (WhatsApp, 13.10.) → isti pregled za Laudato TV, Radio Mariju
Hrvatska, Radio Mariju u BiH i Radio MIR Međugorje. HKM je već riješen (umbrella `hkm`,
commit `84dda299`).

## Metoda

1. `yt-dlp --flat-playlist` nad `/playlists` svakog kanala, pa nad svakom playlistom (trajanja).
2. Format-filter: **≥4 epizode ≥30 min i medijan trajanja ≥25 min**.
3. Za prolaznike točni datumi objave iz YouTube Data API (`playlistItems`, 272 jedinice),
   samo za epizode ≥30 min. `n365` = takvih epizoda u zadnjih 365 dana.
4. Ručna klasifikacija po naslovima: razgovor/intervju/kateheza = kandidat; liturgija,
   molitva, glazba, audio-knjige, prijenosi događaja i agregatne playliste = ne.

| Kanal | channel_id | Pretplatnika | Playlista | Prošlo format | U registryju |
|---|---|---|---|---|---|
| Laudato TV | `UCMNltXN6fWur0K8Z1oubFPA` | — | 113 | 36 | `laudato-tv` (channel, `not-podcast`) + 7 playlista |
| Radio Marija Hrvatska | `UC0QkexsWMyTAQUrFpIjzfAQ` | 9,5k | 84 | 59 | ništa |
| Radio Marija u BiH | `UCEeV5Hg4lLI3XjIouI0ykug` | 23,5k | 146 | 68 | `radio-marija-bih` (channel, `not-podcast`) |
| Radio MIR Međugorje | `UCxLGA4ZfWiBKzhNvGIRyhTA` | 75,4k | 53 | 21 | ništa (`ora-et-labora` je drugi kanal) |

## Laudato TV — najjači izvor

Živo i razgovorno (zadnja epizoda, epizoda ≥30 min u 365 d, medijan min):

| Emisija | Zadnja | n365 | Med | Napomena |
|---|---|---|---|---|
| **Odaziv** | 2026-10-12 | 41 | 55 | razgovor, tematski |
| **Papa s nama** | 2026-10-08 | 28 | 61 | komentar papinih nastupa |
| **Generacija+** | 2026-10-11 | 19 | 45 | već u registryju (`generacija-plus`) |
| **In Familia Dei** | 2026-10-05 | 18 | 46 | obitelji gosti |
| **More milosrđa** | 2026-10-13 | 14 | 87 | svećenici gosti (Nikić, Stojić…) |
| **Otvori spomenar** | 2026-09-24 | 14 | 55 | intervju s poznatima |
| **Susret u Riječi** | 2026-10-13 | 13 | 45 | intervju |
| **Novo srce** | 2026-10-04 | 12 | 43 | već u registryju (`novo-srce`) |
| **Radost ljubavi u braku** | 2026-10-03 | 10 | 60 | brak, razgovor |
| **Život i zdravlje** | 2026-09-21 | 9 | 60 | zdravlje |
| **Totus Tuus** | 2026-10-06 | 7 | 61 | kateheza |
| **Novi Život** | 2026-10-04 | 7 | 73 | nova (04/2026), parovi gosti |
| Svi za stol / Blagoslovljen tek / Zlatni savjeti | ≤ 2026-10-11 | 6–21 | 31–59 | kuharske/savjetodavne — granično, preskočiti |
| Dudo i prijatelji | 2026-07-20 | 10 | 47 | granično |

Ne: `IZDVOJENO - Emisija` (agregat svih emisija → duplikati), `SNIMKE`/`Snimke`/`prijenosi uživo`/`Svete Mise` (događaji, liturgija).
Neaktivno: Jeste li znali?, Moja Hrvatska, Ne bojte se!, Živopisi, Upoznaj Bibliju, Fit katolik, Svjedočanstva, ZUM… (zadnja 2016–2024).
`nota-bene` (zadnja 2026-03-21) usporava.

## Radio Marija Hrvatska — mnogo emisija, rijetko svaka

Radio emisije na YouTubeu (uglavnom statična slika): screenshot korak tu ništa ne donosi.
Pojedinačno rijetke (≤17/god), ali ukupno ~100 dugih epizoda godišnje.

| Emisija | Zadnja | n365 | Med |
|---|---|---|---|
| **Ljubav nikad ne prestaje** (biblijska razmatranja) | 2026-10-06 | 17 | 60 |
| **Kursiljo na Radio Mariji** | 2026-06-08 | 9 | 50 |
| **Bit ću ljubav** | 2026-05-19 | 9 | 58 |
| **Kulturni uskličnik** (kultura, gosti) | 2026-05-22 | 7 | 67 |
| **Snaga Hrvatske** | 2026-04-15 | 6 | 58 |
| **Didaskalije – fusnota na život** | 2026-04-15 | 5 | 50 |
| **Fides per musicam** (glazbenici gosti) | 2026-05-07 | 5 | 52 |
| Nadom nošeni (zdravlje), Kap dobrote, Živimo zajedno, Ne boj se, Vjera te tvoja spasila (svjedočanstva) | 2026-05…08 | 3–4 | 48–58 |

Ne: Radio drame, Zvuci srca (zborovi), Korizmene srijede (sezonsko), duhovne vježbe (događaji).
Sezonski ritam: većina staje u lipnju i kreće u jesen — „zadnja = svibanj" ne znači mrtvo.

## Radio Marija u BiH

| Emisija | Zadnja | n365 | Med |
|---|---|---|---|
| **O Međugorju** | 2026-10-13 | 12 | 42 |
| **Arka** (svjedočanstva) | 2026-06-04 | 11 | 60 |
| **Kršćanine upoznaj svoje dostojanstvo** | 2026-09-26 | 9 | 47 |
| **Idi i popravi moju Crkvu** (franjevačka) | 2026-10-03 | 9 | 42 |
| **Savršeno veselje** (Frama Mostar) | 2026-06-05 | 8 | 37 |
| **Pozvani na slobodu** | 2026-10-07 | 7 | 45 |
| **Medicinsko-psihološki savjeti** | 2026-06-19 | 7 | 32 |
| **Crtice iz povijesti** (Puljić, rat) | 2026-09-29 | 6 | 32 |
| **Stvaramo mostove** | 2026-06-12 | 6 | 51 |
| **Da progledam Gospodine** | 2026-06-20 | 6 | 60 |
| Razgovor bez maski (nova, Stojić…) | 2026-06-26 | 4 | 50 |

Ne: Molitva sa svećenicima (222 ep., molitva), Knjige / Čitamo knjigu (audio-knjige, 6–8 h),
Evanđelje… Marija Valtorta (čitanje), Venite adoremus (klanjanje), Štovanje relikvija (mise).

## Radio MIR Međugorje

| Emisija | Zadnja | n365 | Med | Napomena |
|---|---|---|---|---|
| **Susret** | 2026-06-12 | 24 | 60 | glavni intervju, 218 ep. od 2015.; sezonska pauza |
| **Sitan kamen do kamena** | 2026-10-05 | 10 | 55 | franjevci gosti |
| **Miris zavičaja** | 2026-10-09 | 8 | 31 | |
| **Na putu života** | 2026-10-08 | 4 | 51 | nova (09/2026), tjedno |
| Oaza života | 2026-06-16 | 5 | 29 | granično (medijan <30) |
| Mladifest 32.–37. | godišnje | — | 27–37 | arhiva događaja → tier 4, ne pratiti |

Ne: Glazbe svijeta, Vremeplov klasične glazbe (glazba). Neaktivno: Credo, Agape, Iz evanđelja u život.

## Preporuka

- Umbrella po kanalu (kao `hkm`): pretvoriti `laudato-tv` i `radio-marija-bih` iz
  `not-podcast` kanala u `umbrella`; dodati `radio-marija-hr` i `radio-mir-medjugorje`.
- Kandidati (`tracking.enabled: false`) = podebljane emisije iz tablica (~35).
- Za stvarno praćenje prvi izbor po volumenu i formatu: Laudato **Odaziv**, **Papa s nama**,
  **More milosrđa**, **In Familia Dei**; MIR **Susret** i **Sitan kamen do kamena**.
  Radio Marija emisije su pojedinačno prerijetke da bi se isplatile kao zasebni kanali u
  `refresh_podcasts.sh` dok se ne pokaže potražnja.

Upisano u registry 14.10.2026.: 4 umbrella unosa + 37 novih playlista-kandidata (sve `tracking.enabled: false`).
Sirovi podaci (yt-dlp dumpovi + `dates.json`) bili su u scratchpadu sesije, nisu sačuvani;
ponoviti se mogu za ~1 min yt-dlp + ~270 jedinica YouTube API kvote.

## Dodatak: HRT (isti dan)

Pregled HRT YouTube kanala (subagent: 147 + 18 + 20 playlista; datumi provjereni YouTube API-jem).
Umbrella `hrt` s 23 djece: 10 novih kandidata + 13 postojećih HRT unosa.

| Novo | Izvor | ≥30 min | n365 | Zadnja |
|---|---|---|---|---|
| Otvoreno | HRT vijesti playlista | 1096 | 150 | 2026-10-13 |
| Nedjeljom u 2 | zaseban kanal @nedjeljomu2HRT, `watch.min_duration_sec: 1800` | 421 | 52 | 2026-10-12 |
| Peti dan | glavni kanal | 244 | 33 | 2026-10-09 |
| Povijest četvrtkom | glavni kanal | 164 | 52 | 2026-10-08 |
| Globalna Hrvatska | HRT vijesti | 95 | 45 | 2026-10-09 |
| KRIK | glavni kanal | 138 | 47 | 2026-09-29 |
| Pozitivno | glavni kanal | 130 | 20 | 2026-10-11 |
| Što je klasik? | glavni kanal | 63 | 16 | 2026-10-06 |
| Veterani mira | glavni kanal | 50 | 30 | 2026-06-01 |
| Na rubu znanosti | glavni kanal (pseudoznanost — editorial odluka) | 353 | 67 | 2026-06-15 |

Zamke: playliste Otvoreno i Nedjeljom u 2 na glavnom HRT kanalu su **zastarjele** (zadnja duga
epizoda 04/2025 odnosno 2022) — subagentov „zadnja 08.10." bio je kratki isječak. Isto za
Romano Bolković 1 na 1: unos prebačen na živu playlistu HRT vijesti (stara u `youtube_alternatives`).
Nisu pregledani: radijski podcasti (radio.hrt.hr, RSS) i @HRTkultura.
