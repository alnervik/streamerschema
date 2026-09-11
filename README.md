# NHL-schema

Statiskt schemaverktyg för fantasyhockey, i två flikar.

**Schema** rangordnar NHL-lagen efter hur bra deras schema är under en vald
period: hur många matcher de spelar, hur många av dem som ligger på offnights,
vilka som är back-to-back och vilka som möter ett lag som spelade dagen innan —
samma grundidé som TJStats schema-app, men som ren HTML/JS så att den kan ligga
på GitHub Pages.

**Lediga platser** vänder på det och utgår från ditt eget fantasylag: den fyller
uppställningen dag för dag och visar var du har hål att streama in någon i.

Ingen build, inga beroenden, inget backend. Schemat ligger som JSON i repot och
uppdateras av ett Node-skript som GitHub Actions kör varje natt.

## Kom igång

```bash
node scripts/fetch-schedule.mjs     # skapar data/schedule.json och data/weeks.json
npx serve .                         # eller python3 -m http.server
```

Öppna sedan `http://localhost:3000`. Att dubbelklicka på `index.html` fungerar inte —
`fetch()` mot lokala filer blockeras under `file://`. Använd knappen *Hämta från
NHL:s API* i appen om du ändå vill titta utan att köra skriptet först.

## Lägg upp på GitHub Pages

1. Pusha repot till GitHub.
2. Settings → Pages → Source: **Deploy from a branch**, branch `main`, mapp `/ (root)`.
3. Settings → Actions → General → Workflow permissions: **Read and write permissions**,
   annars kan schemajobbet inte committa.

Workflowen i `.github/workflows/update-schedule.yml` kör varje natt 09:20 UTC och
committar bara om något faktiskt ändrats. Den går också att köra manuellt från
Actions-fliken.

## Veckorna

Yahoos fantasyveckor är måndag–söndag, men premiärveckan är kortare och uppehåll
för OS eller All-Star slår ihop två veckor till en. `data/weeks.json` genereras
med mån–sön som utgångspunkt och rörs sedan aldrig av skriptet.

Veckorna för säsongen är inställda och ligger i
[`data/weeks.json`](data/weeks.json). Appen läser dem rakt av, så alla som öppnar
sidan ser samma datum. Behöver något justeras redigerar du filen och committar —
det finns ingen redigering i appen längre, så ingen kan råka ändra veckorna av
misstag. Saknas filen faller appen tillbaka på mån–sön.

Kör `node scripts/fetch-schedule.mjs --force-weeks` om du vill skriva över filen
och börja om från mån–sön.

## Så räknas siffrorna

Sifferkolumnerna ligger till vänster om rutnätet och är frysta, så de syns även när
man scrollar i sidled genom veckan. Listan sorteras på Poäng från början, och varje
kolumn går att sortera på genom att klicka på rubriken.

| Kolumn | Betydelse |
| --- | --- |
| Poäng | Kolumnerna vägda till ett tal: `matcher + 0,25 × offnights + 0,15 × trötta − 0,3 × B2B` |
| Matcher | Antal matcher laget spelar i perioden |
| Offnights | Hur många av dem som ligger på en offnight |
| B2B | Matcher laget spelar dagen efter en annan match |
| Trötta | Matcher mot ett lag som spelade dagen innan |

En **offnight** är en dag då högst *N* matcher spelas i hela ligan — sex som
standard, alltså tolv lag på isen. Tröskeln ställs in i verktygsraden. Det är de
matcherna som är lättast att få in i laguppställningen, eftersom konkurrensen om
platserna är låg, så de är poängkolumnens tyngsta plusfaktor.

Färgerna är relativa mot urvalet, så skalan fungerar lika bra för en vecka som för
hela grundserien. Gult betyder att mer är bättre, blått att mer är sämre.

| Markering | Betydelse |
| --- | --- |
| Grön cell | Matchen ligger på en offnight |
| Röd kant på brickan | Lagets andra match på två dagar — vila och backupmålvakt är i spel |
| 🥱 | Motståndaren spelade dagen innan och är alltså tröttkörd |

## Lediga platser

Andra fliken svarar på en annan fråga än schemavyn: *var i min egen uppställning
finns det hål?* Du ställer in hur många platser din liga startar — 2 C, 2 LW,
2 RW, 4 D, 1 UTIL, 2 G som standard — och lägger in ditt lag som position och
NHL-lag. Sedan fyller appen varje speldag i perioden och visar vilka platser som
blir stående tomma. Det är där en streamer ska in.

Utöver startplatserna har ligan en bänk, `BN`, som standard 4 platser. Bänkade
spelare ger inga poäng men finns kvar i laget hela veckan och kan ställas in
vilken dag som helst. Startplatserna plus bänken är alltså hur stort laget får
vara, och en tom bänkplats är utrymme att plocka upp en extra spelare på.

Flera lag går att ha samtidigt, ett per fantasyliga, var och ett med sin egen
platsuppsättning och spelarlista. **Kopiera** är genvägen när två ligor har nästan
samma lag.

Spelare läggs enklast in i snabbrutan:

```
D-COL             en back i Colorado
C/LW-TOR          en spelare i Toronto som får ställas på både C och LW
D-COL, G-BOS      flera åt gången
```

Namnet är valfritt och bara en etikett — står det tomt visas spelaren som
`D-COL`. Det är laget och positionerna som styr uträkningen, inte namnet.

Uppställningen fylls med maximal matchning, inte girigt uppifrån: en C/LW som
lagt beslag på UTIL flyttas automatiskt till en C-plats om en ren wing annars
hade blivit utan. Antalet startade spelare per dag blir alltså så högt som det
över huvud taget går, och det som står kvar som **LEDIG** är riktiga hål.

| Markering | Betydelse |
| --- | --- |
| Gul cell, `LEDIG` | Ingen av dina spelare kan fylla platsen den dagen |
| ★ | Den lediga platsen ligger på en offnight — lättast att plocka upp |
| Grå kolumn | Ingen NHL-match alls den dagen, räknas inte med |
| `BN`-rad | Bänken: dina spelare som har match men inte fick en startplats |
| `–` på en `BN`-rad | Ledig bänkplats, alltså plats över för en extra spelare |
| `+2` på sista `BN`-raden | Så många spelare med match får inte plats ens på bänken |
| Bänkade | Dina spelare som har match men inte får plats — laget är för brett den dagen |

Offnight-tröskeln är gemensam med schemavyn, så båda flikarna är överens om
vilka dagar som är offnights.

Lagen sparas i webbläsarens `localStorage` och följer alltså inte med till en
annan dator. Under *Exportera / importera* ligger allihop som JSON att kopiera
över.

## Data

Från NHL:s öppna API (`api-web.nhle.com`), som är odokumenterat och kan ändras utan
förvarning. Skriptet hämtar laglistan från `standings/now` och varje lags säsong från
`club-schedule-season`, dedupar på match-id och sparar grundserie och slutspel.

```
data/schedule.json   genereras – redigera inte för hand
data/weeks.json      dina fantasyveckor – redigeras för hand
```

## Struktur

```
index.html                          markup
styles.css                          stilmall
app.js                              all logik
scripts/fetch-schedule.mjs          hämtar schemat
.github/workflows/update-schedule.yml
```
