import {BuiltinUtterances} from "../model/BuiltinUtterances";
import {DelegatedDialogResponse} from "./DelegatedDialogResponse";
import {DialogIntent} from "./DialogIntent";
import {DialogResponse} from "./DialogResponse";
import {ExplicitDialogResponse} from "./ExplicitDialogResponse";
import {SkillContext} from "../core/SkillContext";
import {SkillResponse} from "../core/SkillResponse";
import {SlotValue} from "../impl/SlotValue";
import {UserIntent} from "../impl/UserIntent";

export enum DialogState {
    COMPLETED = "COMPLETED",
    IN_PROGRESS = "IN_PROGRESS",
    STARTED = "STARTED",
}

export class DialogManager {
    private _delegated: boolean = false;
    private _confirmingIntent: boolean = false;
    private _confirmingSlot: SlotValue = undefined;
    private _confirmationStatus: ConfirmationStatus;
    private _dialogIntent: DialogIntent = undefined;
    private _dialogState: DialogState = undefined;
    private _slots: {[id: string]: SlotValue} = {};
    public constructor(public context: SkillContext) {}

    public handleDirective(response: SkillResponse): DialogResponse | undefined {
        // Look for a dialog directive - trigger dialog mode if so
        for (const directive of response.response.directives) {
            if (directive.type.startsWith("Dialog")) {
                const intentName = directive.updatedIntent.name;
                if (this._dialogIntent && this._dialogIntent.name !== intentName) {
                    throw new Error("Switching dialogs before previous dialog complete. "
                        + " New dialog: " + intentName + " Old Dialog: " + this._dialogIntent.name);
                }

                this._dialogIntent = this.context.interactionModel().dialogIntent(intentName);
                if (!this._dialogIntent) {
                    throw new Error("No match for dialog name: " + intentName);
                }

                if (directive.type === "Dialog.Delegate") {
                    this._delegated = true;
                    this._dialogState = DialogState.STARTED;
                    this._confirmationStatus = ConfirmationStatus.NONE;

                    // We immediately want to get the next response when the dialog directive comes down
                    const dialogResponse = this.processDialog(directive.updatedIntent.name,
                        directive.updatedIntent.slots);
                    if (dialogResponse) {
                        return dialogResponse;
                    }
                } else if (directive.type === "Dialog.ElicitSlot"
                    || directive.type === "Dialog.ConfirmSlot"
                    || directive.type === "Dialog.ConfirmIntent") {
                    // Start the dialog if not started, otherwise mark as in progress
                    this._dialogState = this._dialogState ? DialogState.IN_PROGRESS : DialogState.STARTED;
                    this.updateSlotStates(directive.updatedIntent.slots);

                    if (directive.type === "Dialog.ConfirmSlot") {
                        const slotToConfirm = directive.slotToConfirm;
                        this._confirmingSlot = this.slots()[slotToConfirm];
                    } else if (directive.type === "Dialog.ConfirmIntent") {
                        this._confirmingIntent = true;
                        this._dialogState = DialogState.COMPLETED;
                    }
                    // For explicit slot handling, the output speech from the skill response is used
                    return undefined;
                }

            }
        }
        return undefined;
    }

    public confirmationStatus() {
        return this._confirmationStatus;
    }

    public handleUtterance(utterance: string): UserIntent {
        // If we are in confirmation mode, check if this is yes or no
        if (this._confirmingSlot || this._dialogState === DialogState.COMPLETED) {
            const intent = BuiltinUtterances.values()["AMAZON.YesIntent"].indexOf(utterance) !== -1 ?
                "AMAZON.YesIntent" :
                "AMAZON.NoIntent";

            return new UserIntent(this.context, intent);
        }
        return undefined;
    }

    public handleIntent(intent: UserIntent): DialogResponse | void {
        if (this.isDialog()) {
            return this.processDialog(intent.name, intent.slots());
        } else if (this.context.interactionModel().dialogIntent(intent.name)) {
            // If we have not started a dialog yet, if this intent ties off to a dialog, save the slot state
            this.updateSlotStates(intent.slots());
        }
    }

    public isDelegated() {
        return this._delegated;
    }

    public isDialog() {
        return this._dialogState !== undefined;
    }

    public dialogState() {
        return this._dialogState;
    }

    public slots() {
        return this._slots;
    }

    private confirmationPrompt(slots: {[id: string]: SlotValue}): string {
        return this.context.interactionModel().prompt(this._dialogIntent.prompts.confirmation).variation(slots);
    }

    private updateSlotStates(slots: {[id: string]: SlotValue}): void {
        if (!slots) {
            return;
        }

        for (const slotName of Object.keys(slots)) {
            const slot = this._slots[slotName];
            if (slot) {
                slot.update(slots[slotName]);
            } else {
                this._slots[slotName] = slots[slotName];
            }
        }
    }

    private processDialog(intentName: string, slots: {[id: string]: SlotValue}): DialogResponse | undefined {
        // Check if we are confirming the intent as a whole
        // We are confirming the intent when the dialog is completed and either:
        //  The confirm is required for the dialog if it is delegated and the dialog is set to confirmation required
        //  OR an explicit confirmIntent directive has been sent
        const confirmationRequired = (this.isDelegated() && this._dialogIntent.confirmationRequired)
            || this._confirmingIntent;
        if (this._dialogState === DialogState.COMPLETED
            && confirmationRequired
            && this._confirmationStatus === ConfirmationStatus.NONE
        ) {
            this._confirmationStatus = (intentName === "AMAZON.YesIntent")
                ? ConfirmationStatus.CONFIRMED
                : ConfirmationStatus.DENIED;
            return new ExplicitDialogResponse(new UserIntent(this.context, this._dialogIntent.name));
        }

        // If we are confirming a slot, then answer should be yes or no
        if (this._confirmingSlot) {
            this._confirmingSlot.confirmationStatus = (intentName === "AMAZON.YesIntent")
                ? ConfirmationStatus.CONFIRMED
                : ConfirmationStatus.DENIED;
            // If this confirmed, exit slot confirming mode
            if (this._confirmingSlot.confirmationStatus === ConfirmationStatus.CONFIRMED) {
                this._confirmingSlot = undefined;
            }
        } else {
            this.updateSlotStates(slots);
        }

        // Stop processing here if this is not a delegated dialog
        if (!this.isDelegated()) {
            return new ExplicitDialogResponse(new UserIntent(this.context, this._dialogIntent.name));
        }

        // Now figure out the next slot
        for (const slot of this._dialogIntent.slots) {
            const slotState = this._slots[slot.name];
            if (slotState && slotState.value) {
                if (slot.confirmationRequired) {
                    if (slotState.confirmationStatus === ConfirmationStatus.NONE) {
                        this._confirmingSlot = slotState;
                        return new DelegatedDialogResponse(slot.confirmationPrompt().variation(this.slots()));
                    } else if (slotState.confirmationStatus === ConfirmationStatus.DENIED) {
                        return new DelegatedDialogResponse(slot.elicitationPrompt().variation(this.slots()));
                    }
                }
            } else if (slot.elicitationRequired) { // If no slot state, and elicitation required, do this next
                const prompt = slot.elicitationPrompt();
                return new DelegatedDialogResponse(prompt.variation(this.slots()));
            }
        }

        // dialog state is done if we get here - we do not need to return anything
        this._dialogState = DialogState.COMPLETED;
        if (this._dialogIntent.confirmationRequired) {
            return new DelegatedDialogResponse(this.confirmationPrompt(this.slots()));
        }
        return undefined;
    }
}

export enum ConfirmationStatus {
    CONFIRMED = "CONFIRMED",
    DENIED = "DENIED",
    NONE = "NONE",
}