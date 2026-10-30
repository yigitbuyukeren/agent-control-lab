# Claude Code kota toplayıcısı (isteğe bağlı)

`statusline-collect`, Claude Code'un statusLine komutuna verdiği JSON'dan yalnızca 5 saatlik ve 7 günlük
kullanım yüzdelerini, reset zamanlarını ve güncelleme zamanını yerel bir önbelleğe yazar. Ham JSON,
oturum bilgisi ve kimlik verileri saklanmaz. Proje hiçbir ayar dosyasını kendiliğinden değiştirmez; GUI'deki kurulum yalnızca senin açık onayınla çalışır.

## Kurulum (kendi ayarına sen eklersin)

`~/.claude/settings.json` içine:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node /MUTLAK/YOL/agent-control-lab/apps/cli/bin/agent-control-lab.js statusline-collect"
  }
}
```

Toplayıcı stdout'a bir şey yazmaz, yani durum çubuğu boş kalır. Zaten bir statusLine betiğin varsa, aynı
girdiyi ikisine de ver:

```bash
input=$(cat)
printf '%s' "$input" | node /MUTLAK/YOL/agent-control-lab/apps/cli/bin/agent-control-lab.js statusline-collect
printf '%s' "$input" | ./senin-betigin.sh
```

## Okuma

```bash
pnpm cli quota claude
```

Veri 15 dakikadan eskiyse, eksikse, bozuksa veya pencerenin reset zamanı geçmişse ilgili alan `unknown`
görünür.

## Önbellek

- macOS: `~/Library/Caches/agent-control-lab/`
- Linux: `$XDG_CACHE_HOME` veya `~/.cache/agent-control-lab/`
- Windows: `%LOCALAPPDATA%\agent-control-lab\`
- `ACL_CACHE_DIR` ile değiştirilebilir. Dizin yalnızca sahibine açık oluşturulur, dosya atomik yazılır.

## GUI'den kurulum ve teşhis (isteğe bağlı)

`pnpm cli gui` → Sağlayıcılar → "Claude kota entegrasyonu". Kart, ayar dosyasını (`$CLAUDE_CONFIG_DIR` ya da
`~/.claude/settings.json`), statusLine durumunu ve önbelleği gösterir; veri yoksa nedenini yazar: kurulu değil,
başka statusLine var, ayar dosyası okunamıyor, toplayıcı kurulu ama henüz veri gelmedi, veri 15 dakikadan eski,
pencereler sıfırlanmış, önbellek bozuk. Kullanılan tek kaynak Claude Code'un statusLine girdisidir (Keychain,
token, belgesiz API, kazıma, tahmin ve model çağrısı yok). Veri yalnızca açık bir Claude Code oturumu durum
çubuğunu çizerken ve Claude Code kullanım sınırı bilgisini gönderdiğinde güncellenir.

**Kur** (onay penceresi yazılacak komutu ve dosyayı gösterir):

- statusLine yoksa `{"type":"command","command":"\"node\" \"…/agent-control-lab.js\" statusline-collect"}` eklenir.
- Zaten bir komutun varsa ezilmez, **zincirlenir**: `statusline-collect --chain <kodlanmış özgün komut>`. Toplayıcı
  önce yüzdeleri yazar, sonra özgün komutu kabuk üzerinden aynı girdiyle çalıştırır; çıktısı, hata çıktısı ve çıkış
  kodu aynen geçer. Önbellek yazılamasa bile senin durum çubuğun çalışmaya devam eder.
- Diğer tüm ayar anahtarları korunur. Dosya, yorum ya da sondaki virgül yüzünden JSON olarak okunamıyorsa hiç yazılmaz.
  Yazma atomiktir, dosya izinleri korunur; dosya 2 boşluk girintiyle yeniden biçimlenir.
- Önceki `statusLine` değeri ve ayar dosyasının tam kopyası önbellek dizinine (yalnızca sahibine açık) kaydedilir.

**Geri al** statusLine'ı kurulumdan önceki değerine aynen döndürür (yoksa anahtarı kaldırır). Kurulumdan sonra
sen statusLine'ı değiştirdiysen dokunmaz ve nedenini söyler. Elle kurulmuş bir toplayıcı için otomatik geri alma yoktur.
Yalnızca kullanıcı ayarı kapsamı değiştirilir (proje/yerel/yönetilen ayarlara dokunulmaz).

Taze Claude verisi varken bir gerçek koşu, 5 saatlik ya da 7 günlük pencere %95 ve üzerindeyse başlamaz.
