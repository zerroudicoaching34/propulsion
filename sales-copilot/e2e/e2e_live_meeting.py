"""End-to-end test of the real desktop app (Linux + tauri-driver + WebKitWebDriver).

Drives the compiled binary through a full fictional R1: prospect sheet, meeting,
consent, live screen, typed conversation, question tracking, suggestions, speaker
correction, debrief. The microphone is not available in CI, so the test also checks
that listening refuses to start cleanly without a Whisper model.

Usage (Linux, from sales-copilot/):
  npx tauri build --debug --no-bundle   (rebuild after any `cargo test`: it overwrites the debug binary)
  python3 e2e/e2e_live_meeting.py [screenshot_dir]
Requires: Xvfb, WebKitWebDriver (webkit2gtk-driver), `cargo install tauri-driver`, `pip install selenium`.
tauri-driver does not support macOS; on the Mac, follow docs/USER_GUIDE.md manually.
"""

import os
import subprocess
import sys
import tempfile
import time

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.common.options import ArgOptions
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP = os.path.join(ROOT, "src-tauri", "target", "debug", "ss-sales-copilot")
SHOTS = sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp()

CONVERSATION = [
    ("coach", "Bonjour Camille. Pour commencer, pouvez-vous me décrire votre quotidien en ce moment ?"),
    ("prospect", "Je travaille dans une banque, souvent en télétravail, avec deux enfants, mon rythme est chargé."),
    ("coach", "Et quel est votre objectif ?"),
    ("prospect", "J'aimerais perdre 8 kilos et me sentir mieux dans ma silhouette."),
    ("prospect", "J'ai déjà essayé trois fois : Weight Watchers, la salle de sport avec un abonnement, puis un régime keto."),
    ("prospect", "Seule je lâche vite, j'ai besoin d'un cadre. Je peux venir deux fois par semaine, mon budget c'est 800 euros par mois."),
    ("prospect", "C'est quoi la différence entre vos formules ?"),
    ("coach", "Je vais réfléchir à ce qui vous conviendrait le mieux."),  # deliberately mis-attributed, corrected below
]


def xp(text, tag="*"):
    return f"//{tag}[contains(normalize-space(.), \"{text}\")]"


def main():
    env = dict(os.environ)
    env.setdefault("DISPLAY", ":99")
    env["XDG_DATA_HOME"] = tempfile.mkdtemp(prefix="sscopilot-e2e-")
    env["WEBKIT_DISABLE_COMPOSITING_MODE"] = "1"
    driver_proc = subprocess.Popen(["tauri-driver"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1.5)
    opts = ArgOptions()
    opts.set_capability("browserName", "wry")
    opts.set_capability("tauri:options", {"application": APP})
    d = webdriver.Remote("http://127.0.0.1:4444", options=opts)
    wait = WebDriverWait(d, 20)
    step = [0]

    def shot(name):
        step[0] += 1
        d.save_screenshot(os.path.join(SHOTS, f"{step[0]:02d}-{name}.png"))

    def click(text, tag="button"):
        el = wait.until(EC.element_to_be_clickable((By.XPATH, xp(text, tag))))
        el.click()
        return el

    def field(label):
        return d.find_element(By.XPATH, f"//label[.//span[normalize-space(.)='{label}']]//*[self::input or self::textarea]")

    try:
        wait.until(EC.presence_of_element_located((By.XPATH, xp("Tableau de bord", "h1"))))
        shot("dashboard")

        # 1. Prospect sheet
        click("Prospects")
        click("+ Nouvelle fiche")
        field("Prénom").send_keys("Camille")
        field("Nom").send_keys("Exemple")
        field("Objectif").send_keys("Perdre 8 kg")
        click("Enregistrer")
        wait.until(EC.presence_of_element_located((By.XPATH, xp("Camille Exemple", "h1"))))
        # 2. Plan an R1
        click("Planifier")
        wait.until(EC.presence_of_element_located((By.XPATH, xp("planifié", "span"))))
        shot("prospect-sheet")
        click("Démarrer")

        # 3. Consent gate: listening impossible before consent
        wait.until(EC.presence_of_element_located((By.XPATH, xp("Consentement avant l'écoute", "h1"))))
        assert not d.find_elements(By.XPATH, xp("Démarrer l'écoute", "button")), "listening control visible before consent"
        btn = d.find_element(By.XPATH, xp("Enregistrer le consentement", "button"))
        assert not btn.is_enabled(), "consent button must be disabled until the box is ticked"
        shot("consent")
        d.find_element(By.XPATH, "//label[contains(., 'a donné son accord')]/input").click()
        btn.click()

        # 4. Live screen: three columns
        wait.until(EC.presence_of_element_located((By.XPATH, xp("Démarrer l'écoute", "button"))))
        for col in ["Progression", "Objections et clarifications"]:
            assert d.find_elements(By.XPATH, xp(col)), col
        # No Whisper model configured: start must fail cleanly and the mic must stay off.
        click("Démarrer l'écoute")
        wait.until(EC.presence_of_element_located((By.XPATH, "//*[@role='alert'][contains(., 'Whisper') or contains(., 'micro') or contains(., 'Micro')]")))
        assert d.find_elements(By.XPATH, xp("Micro coupé", "span")), "microphone indicator should stay off"
        assert not d.find_elements(By.XPATH, xp("Micro actif", "span"))
        shot("live-no-model")

        # 5. Type the fictional conversation
        sel = d.find_element(By.XPATH, "//select[@aria-label='Locuteur de la note']")
        note = d.find_element(By.XPATH, "//input[contains(@placeholder, 'Saisir ce qui a été dit')]")
        for speaker, text in CONVERSATION:
            sel.find_element(By.XPATH, f"./option[@value='{speaker}']").click()
            note.send_keys(text)
            note.send_keys(Keys.ENTER)
            time.sleep(0.25)
        wait.until(lambda drv: len(drv.find_elements(By.XPATH, "//li[contains(@class,'group')]")) == len(CONVERSATION))
        shot("live-conversation")

        # 6. Question tracking: attempts given spontaneously are marked as covered
        attempts = d.find_element(By.XPATH, "//li[.//span[contains(., 'Tentatives précédentes')]]")
        assert "Traitée" in attempts.text, attempts.text
        assert "Weight Watchers" in attempts.text
        objective = d.find_element(By.XPATH, "//li[.//span[contains(., 'Objectif physique')]]")
        assert "Traitée" in objective.text

        # 7. Suggestions: at most three, clarification request detected, dismiss works
        cards = d.find_elements(By.XPATH, "//button[normalize-space(.)='Ignorer']")
        assert 1 <= len(cards) <= 3, len(cards)
        assert d.find_elements(By.XPATH, xp("Demande de clarification")), "clarification not detected"
        first_title = d.find_element(By.XPATH, "(//button[normalize-space(.)='Ignorer'])[1]/ancestor::div[contains(@class,'card')][1]").text
        cards[0].click()
        time.sleep(0.3)
        after = d.find_elements(By.XPATH, "(//button[normalize-space(.)='Ignorer'])[1]/ancestor::div[contains(@class,'card')][1]")
        assert not after or after[0].text != first_title, "dismissed suggestion still first"

        # 8. Manual validation of a question (click the chip)
        dm = d.find_element(By.XPATH, "//li[.//span[contains(., 'Personnes impliquées')]]//button")
        dm.click()
        time.sleep(0.2)
        assert "validé manuellement" in d.find_element(By.XPATH, "//li[.//span[contains(., 'Personnes impliquées')]]").get_attribute("innerHTML")

        # 9. Speaker correction of the last (mis-attributed) segment
        last = d.find_elements(By.XPATH, "//li[contains(@class,'group')]")[-1]
        speaker_btn = last.find_element(By.XPATH, ".//button[@title='Corriger le locuteur']")
        assert speaker_btn.text == "Coach"
        speaker_btn.click()  # coach -> à attribuer
        time.sleep(0.3)
        speaker_btn = d.find_elements(By.XPATH, "//li[contains(@class,'group')]")[-1].find_element(By.XPATH, ".//button[@title='Corriger le locuteur']")
        speaker_btn.click()  # -> prospect
        wait.until(lambda drv: drv.find_elements(By.XPATH, "//li[contains(@class,'group')]")[-1].find_element(By.XPATH, ".//button[@title='Corriger le locuteur']").text == "Prospect")
        assert "(corrigé)" in d.find_elements(By.XPATH, "//li[contains(@class,'group')]")[-1].text
        shot("live-after-corrections")

        # 10. Analysis screen
        click("Analyse conversationnelle")
        wait.until(EC.presence_of_element_located((By.XPATH, xp("Préférences de communication observées"))))
        assert d.find_elements(By.XPATH, xp("Advanced", "div")), "expected orientation Advanced for this fictional prospect"
        shot("analysis")

        # 11. Finish -> debrief
        click("Rendez-vous en direct")
        click("Terminer → débriefing")
        wait.until(EC.presence_of_element_located((By.XPATH, xp("Débriefing R1", "h1"))))
        body = d.find_element(By.TAG_NAME, "body").text
        assert "Perdre 8 kg" in body
        assert "Souhaite réfléchir" in body, "reflection objection should appear in debrief"
        assert "Conservation désactivée" in body
        shot("debrief")
        click("Enregistrer")
        time.sleep(0.5)

        # 12. Dashboard reflects real data
        click("Tableau de bord")
        wait.until(EC.presence_of_element_located((By.XPATH, xp("Rendez-vous terminés"))))
        tiles = "".join(d.find_element(By.XPATH, "//div[contains(@class,'grid')][.//div[contains(., 'Rendez-vous terminés')]]").text.split())
        assert "Rendez-vousterminés1" in tiles, tiles
        assert "Décisionsenregistrées1" in tiles, tiles
        shot("dashboard-after")
        print(f"E2E OK — screenshots in {SHOTS}")
    except Exception:
        shot("failure")
        raise
    finally:
        d.quit()
        driver_proc.terminate()


if __name__ == "__main__":
    main()
