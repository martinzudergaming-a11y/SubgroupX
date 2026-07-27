import { useEffect, useState } from "react";
import { PRODUCT_NAME } from "../../platform/brand.ts";
import { Check, Download, Share, SquarePlus } from "lucide-react";
import {
  Modal,
  ModalContent,
  ModalDescription,
  ModalHeader,
  ModalTitle,
} from "../../ui/Modal.tsx";
import {
  currentInstallEnvironment,
  installState,
  runInstallPrompt,
  subscribeInstallPrompt,
  type InstallState,
} from "../../platform/install-app.ts";
import { useT } from "../../i18n";
import { primaryButtonClass } from "../ui/controlStyles.ts";

function Step({ n, icon, children }: { n: number; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="mt-[1px] flex size-5 shrink-0 items-center justify-center rounded-full bg-[#EDEFE9] text-[11px] font-semibold tabular-nums text-[#5F635A] dark:bg-[#2B2D28] dark:text-[#A8ABA3]">
        {n}
      </span>
      <span className="flex flex-1 flex-wrap items-center gap-x-1.5 gap-y-1 text-[12.5px] leading-[1.6] text-[#4A4D46] dark:text-[#BFC2BA]">
        {children}
        {icon}
      </span>
    </li>
  );
}

function MenuName({ icon, children }: { icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-[4px] border border-[#DDE1D8] bg-[#F7F8F4] px-1.5 py-[1px] text-[11.5px] font-medium text-[#3A3D36] dark:border-[#3A3C37] dark:bg-[#26271F] dark:text-[#D9DBD4]">
      {icon}
      {children}
    </span>
  );
}

export function InstallAppDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useT();
  const [state, setState] = useState<InstallState>(() => installState(currentInstallEnvironment()));
  const [installed, setInstalled] = useState(false);

  useEffect(() => subscribeInstallPrompt(() => setState(installState(currentInstallEnvironment()))), []);

  async function install() {
    const accepted = await runInstallPrompt();
    if (accepted) setInstalled(true);
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent className="!max-w-[460px]" data-testid="install-app-dialog">
        <ModalHeader className="px-6 pb-3 pt-5">
          <ModalTitle className="text-[16px] font-semibold tracking-[-0.02em]">{t("install.title", { product: PRODUCT_NAME })}</ModalTitle>
          <ModalDescription className="mt-1.5 text-[12.5px] leading-[1.55]">
            {t("install.blurb")}
          </ModalDescription>
        </ModalHeader>

        <div className="px-6 pb-6" data-testid={`install-state-${installed ? "installed" : state}`}>
          {installed || state === "installed" ? (
            <p className="flex items-center gap-2 text-[12.5px] text-[#3F7A5C] dark:text-[#79BE9B]">
              <Check className="size-4 shrink-0" strokeWidth={2} />
              {t("install.alreadyInstalled")}
            </p>
          ) : state === "prompt" ? (
            <button type="button" data-testid="install-app-run" onClick={install} className={primaryButtonClass}>
              <Download className="size-3.5" strokeWidth={2} />
              {t("install.action")}
            </button>
          ) : state === "ios" ? (
            <ol className="flex flex-col gap-3">
              <Step n={1} icon={<Share className="size-[15px] text-[#5F635A] dark:text-[#A8ABA3]" strokeWidth={1.7} />}>
                {t("install.ios.1")}
              </Step>
              <Step n={2}>
                {t("install.ios.2")}
                <MenuName icon={<SquarePlus className="size-[13px]" strokeWidth={1.7} />}>
                  {t("install.ios.addToHome")}
                </MenuName>
              </Step>
              <Step n={3}>{t("install.ios.3")}</Step>
            </ol>
          ) : state === "desktop-safari" ? (
            <ol className="flex flex-col gap-3">
              <Step n={1}>
                {t("install.safari.1")}
                <MenuName>{t("install.safari.file")}</MenuName>
              </Step>
              <Step n={2}>
                {t("install.safari.2")}
                <MenuName>{t("install.safari.addToDock")}</MenuName>
              </Step>
            </ol>
          ) : (
            <p className="text-[12.5px] leading-[1.6] text-[#686C63] dark:text-[#A0A39B]">
              {t("install.manual")}
            </p>
          )}
        </div>
      </ModalContent>
    </Modal>
  );
}
