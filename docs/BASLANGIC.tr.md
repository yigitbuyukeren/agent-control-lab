# Başlangıç rehberi (Türkçe)

Agent Control Lab, bilgisayarınızdaki **orijinal Claude Code ve Codex CLI**'larını yöneten yerel bir araçtır. Kendi modeli yoktur,
API anahtarı kullanmaz; kendi aboneliklerinizle oturum açmış CLI'ları çalıştırır ve çevresine güvenlik önlemleri koyar.

## Gerekenler

- Node.js 24 veya üstü, Git
- Claude Code ve/veya Codex (en az biri), abonelik hesabıyla oturum açılmış

## Kurulum

```bash
npm install -g ./agent-control-lab-<sürüm>.tgz   # GitHub Release paketi
agent-control-lab doctor                          # ilk kurulum denetimi, model çağırmaz
```

`doctor` eksikleri ve ne yapmanız gerektiğini söyler (Node sürümü, Git, Claude/Codex kurulumu ve oturumu, işletim sistemi sandbox'ı).

## Terminalsiz kullanım

```bash
agent-control-lab gui
```

Tarayıcıda açılan ekran yalnızca bu bilgisayarda erişilebilir. Akış: **Hazırlık** (kurulum denetimi) → proje seçimi → görev →
(isteğe bağlı) çalışma ağacı oluşturma → **önizleme (dry run)** → açık onay → canlı ilerleme → diff, test ve inceleme.

## Terminalle kısa akış

```bash
agent-control-lab workspaces --root ~/kod --task "fatura yeniden deneme hatasını düzelt"   # öneri verir, seçmez
agent-control-lab instructions --cwd ~/kod/fatura                                         # hangi CLAUDE.md / AGENTS.md okunur
agent-control-lab worktree create --repo ~/kod/fatura                                     # önce plan; --confirm ile oluşturur
agent-control-lab orchestrate --workflow plan-implement-review --task "..." --workspace <çalışma ağacı> --dry-run
```

Gerçek çalıştırma yalnızca `--confirm-write` ile başlar, abonelik kotanızı kullanır ve **hiçbir zaman commit veya push yapmaz**.
Yalnızca Claude, yalnızca Codex ya da ikisi birlikte kullanılabilir: `--step-provider plan=codex --step-provider review=codex` gibi.

## Önemli güvenlik notları

- Yazma yalnızca bağlı bir Git çalışma ağacında ve korumalı olmayan bir dalda yapılır; ana depo değişmez.
- Test komutu (`--verify-command`) yalnızca kanıtlanmış bir işletim sistemi sandbox'ında çalışır (macOS, Linux). Windows'ta sandbox
  yoktur: komut çalıştırılmaz; WSL2 kullanın ya da bilerek `--verify-unsandboxed` seçin (tam kullanıcı haklarıyla çalışır).
- Görev geçmişi yerelde tutulur ve istem, model çıktısı veya plan metni içermez: `agent-control-lab tasks`. Silmek için `tasks clear`.
- Talimat dosyaları (`CLAUDE.md`, `AGENTS.md`) güvenilmeyen veri sayılır; izinleri artıramaz.

## Sorun giderme

[TROUBLESHOOTING.md](TROUBLESHOOTING.md) (İngilizce). En sık görülenler: oturum açık değil → ilgili CLI'ı bir kez açıp giriş yapın;
çalışma ağacı kirli → değişiklikleri kendiniz işleyin veya atın; sandbox yok → `doctor` çıktısındaki yönergeyi izleyin.
