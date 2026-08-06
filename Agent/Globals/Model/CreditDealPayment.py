import uuid
from datetime import datetime
from Globals.Enumerations.CreditDealTargetTypes import CreditDealTargetTypes
from Globals.Enumerations.CreditDealPaymentModes import CreditDealPaymentModes
from Globals.Enumerations.CreditDealPaymentStatuses import CreditDealPaymentStatuses
from Globals.Enumerations.PaymentProviders import PaymentProviders


class CreditDealPayment:
    def __init__(self, target_type: CreditDealTargetTypes = CreditDealTargetTypes(0), target_id: str = '', label: str = '', mode: CreditDealPaymentModes = CreditDealPaymentModes(0), status: CreditDealPaymentStatuses = CreditDealPaymentStatuses(0), amount_minor: int = 0, currency: str = 'INR', payment_provider: PaymentProviders = PaymentProviders(0), provider_order_id: str = '', provider_payment_id: str = '', invoice_file_name: str = '', invoice_mime_type: str = '', invoice_bucket_path: str = '', invoice_size_bytes: int = 0, invoice_uploaded_at: datetime = datetime.now(), has_invoice: bool = False, created_by_user_id: str = '', created_at: datetime = datetime.now(), captured_at: datetime = datetime.now(), additional_data: dict = {}) -> None:
        self.__id = str(uuid.uuid4())
        self.set_target_type(target_type)
        self.set_target_id(target_id)
        self.set_label(label)
        self.set_mode(mode)
        self.set_status(status)
        self.set_amount_minor(amount_minor)
        self.set_currency(currency)
        self.set_payment_provider(payment_provider)
        self.set_provider_order_id(provider_order_id)
        self.set_provider_payment_id(provider_payment_id)
        self.set_invoice_file_name(invoice_file_name)
        self.set_invoice_mime_type(invoice_mime_type)
        self.set_invoice_bucket_path(invoice_bucket_path)
        self.set_invoice_size_bytes(invoice_size_bytes)
        self.set_invoice_uploaded_at(invoice_uploaded_at)
        self.set_has_invoice(has_invoice)
        self.set_created_by_user_id(created_by_user_id)
        self.set_created_at(created_at)
        self.set_captured_at(captured_at)
        self.set_additional_data(additional_data)

    def get_id(self) -> str:
        return self.__id

    def get_target_type(self) -> CreditDealTargetTypes:
        return self.__target_type

    def set_target_type(self, value: CreditDealTargetTypes) -> None:
        if value is not None:
            valid_values = list(CreditDealTargetTypes)
            if value not in valid_values:
                value = valid_values[0] if valid_values else None
        self.__target_type = value

    def get_target_id(self) -> str:
        return self.__target_id

    def set_target_id(self, value: str) -> None:
        if value is not None:
            value = str(value)
        self.__target_id = value

    def get_label(self) -> str:
        return self.__label

    def set_label(self, value: str) -> None:
        if value is not None:
            value = str(value)
            if len(value) > 256:
                value = value[:256]
        self.__label = value

    def get_mode(self) -> CreditDealPaymentModes:
        return self.__mode

    def set_mode(self, value: CreditDealPaymentModes) -> None:
        if value is not None:
            valid_values = list(CreditDealPaymentModes)
            if value not in valid_values:
                value = valid_values[0] if valid_values else None
        self.__mode = value

    def get_status(self) -> CreditDealPaymentStatuses:
        return self.__status

    def set_status(self, value: CreditDealPaymentStatuses) -> None:
        if value is not None:
            valid_values = list(CreditDealPaymentStatuses)
            if value not in valid_values:
                value = valid_values[0] if valid_values else None
        self.__status = value

    def get_amount_minor(self) -> int:
        return self.__amount_minor

    def set_amount_minor(self, value: int) -> None:
        if value is not None:
            try:
                value = int(value)
                value = max(0, value)
            except (ValueError, TypeError):
                value = 0
        self.__amount_minor = value

    def get_currency(self) -> str:
        return self.__currency

    def set_currency(self, value: str) -> None:
        if value is not None:
            value = str(value)
            if len(value) > 8:
                value = value[:8]
        self.__currency = value

    def get_payment_provider(self) -> PaymentProviders:
        return self.__payment_provider

    def set_payment_provider(self, value: PaymentProviders) -> None:
        if value is not None:
            valid_values = list(PaymentProviders)
            if value not in valid_values:
                value = valid_values[0] if valid_values else None
        self.__payment_provider = value

    def get_provider_order_id(self) -> str:
        return self.__provider_order_id

    def set_provider_order_id(self, value: str) -> None:
        if value is not None:
            value = str(value)
        self.__provider_order_id = value

    def get_provider_payment_id(self) -> str:
        return self.__provider_payment_id

    def set_provider_payment_id(self, value: str) -> None:
        if value is not None:
            value = str(value)
        self.__provider_payment_id = value

    def get_invoice_file_name(self) -> str:
        return self.__invoice_file_name

    def set_invoice_file_name(self, value: str) -> None:
        if value is not None:
            value = str(value)
            if len(value) > 512:
                value = value[:512]
        self.__invoice_file_name = value

    def get_invoice_mime_type(self) -> str:
        return self.__invoice_mime_type

    def set_invoice_mime_type(self, value: str) -> None:
        if value is not None:
            value = str(value)
            if len(value) > 128:
                value = value[:128]
        self.__invoice_mime_type = value

    def get_invoice_bucket_path(self) -> str:
        return self.__invoice_bucket_path

    def set_invoice_bucket_path(self, value: str) -> None:
        if value is not None:
            value = str(value)
        self.__invoice_bucket_path = value

    def get_invoice_size_bytes(self) -> int:
        return self.__invoice_size_bytes

    def set_invoice_size_bytes(self, value: int) -> None:
        if value is not None:
            try:
                value = int(value)
                value = max(0, value)
            except (ValueError, TypeError):
                value = 0
        self.__invoice_size_bytes = value

    def get_invoice_uploaded_at(self) -> datetime:
        return self.__invoice_uploaded_at

    def set_invoice_uploaded_at(self, value: datetime) -> None:
        if value is not None:
            if isinstance(value, str):
                try:
                    value = datetime.fromisoformat(value)
                except ValueError:
                    value = datetime.now()
            elif not isinstance(value, datetime):
                value = datetime.now()
        else:
            value = datetime.now()
        self.__invoice_uploaded_at = value

    def get_has_invoice(self) -> bool:
        return self.__has_invoice

    def set_has_invoice(self, value: bool) -> None:
        if value is not None:
            value = bool(value)
        self.__has_invoice = value

    def get_created_by_user_id(self) -> str:
        return self.__created_by_user_id

    def set_created_by_user_id(self, value: str) -> None:
        if value is not None:
            value = str(value)
        self.__created_by_user_id = value

    def get_created_at(self) -> datetime:
        return self.__created_at

    def set_created_at(self, value: datetime) -> None:
        if value is not None:
            if isinstance(value, str):
                try:
                    value = datetime.fromisoformat(value)
                except ValueError:
                    value = datetime.now()
            elif not isinstance(value, datetime):
                value = datetime.now()
        else:
            value = datetime.now()
        self.__created_at = value

    def get_captured_at(self) -> datetime:
        return self.__captured_at

    def set_captured_at(self, value: datetime) -> None:
        if value is not None:
            if isinstance(value, str):
                try:
                    value = datetime.fromisoformat(value)
                except ValueError:
                    value = datetime.now()
            elif not isinstance(value, datetime):
                value = datetime.now()
        else:
            value = datetime.now()
        self.__captured_at = value

    def get_additional_data(self) -> dict:
        return self.__additional_data

    def set_additional_data(self, value: dict) -> None:
        self.__additional_data = value

    def _restore_id_id(self, stored_id):
        if stored_id is not None:
            self.__id = stored_id

    def to_json(self) -> dict:
        return {
            'id': self.get_id(),
            'targetType': int(self.get_target_type().value) if self.get_target_type() is not None else None,
            'targetId': self.get_target_id(),
            'label': self.get_label(),
            'mode': int(self.get_mode().value) if self.get_mode() is not None else None,
            'status': int(self.get_status().value) if self.get_status() is not None else None,
            'amountMinor': self.get_amount_minor(),
            'currency': self.get_currency(),
            'paymentProvider': int(self.get_payment_provider().value) if self.get_payment_provider() is not None else None,
            'providerOrderId': self.get_provider_order_id(),
            'providerPaymentId': self.get_provider_payment_id(),
            'invoiceFileName': self.get_invoice_file_name(),
            'invoiceMimeType': self.get_invoice_mime_type(),
            'invoiceBucketPath': self.get_invoice_bucket_path(),
            'invoiceSizeBytes': self.get_invoice_size_bytes(),
            'invoiceUploadedAt': self.get_invoice_uploaded_at().isoformat() if self.get_invoice_uploaded_at() is not None else None,
            'hasInvoice': self.get_has_invoice(),
            'createdByUserId': self.get_created_by_user_id(),
            'createdAt': self.get_created_at().isoformat() if self.get_created_at() is not None else None,
            'capturedAt': self.get_captured_at().isoformat() if self.get_captured_at() is not None else None,
            'additionalData': self.get_additional_data(),
        }

    @classmethod
    def from_json(cls, data: dict) -> 'CreditDealPayment':
        instance = cls(
            target_type=CreditDealTargetTypes(data.get('targetType')) if data.get('targetType') is not None else None,
            target_id=data.get('targetId'),
            label=data.get('label'),
            mode=CreditDealPaymentModes(data.get('mode')) if data.get('mode') is not None else None,
            status=CreditDealPaymentStatuses(data.get('status')) if data.get('status') is not None else None,
            amount_minor=data.get('amountMinor'),
            currency=data.get('currency'),
            payment_provider=PaymentProviders(data.get('paymentProvider')) if data.get('paymentProvider') is not None else None,
            provider_order_id=data.get('providerOrderId'),
            provider_payment_id=data.get('providerPaymentId'),
            invoice_file_name=data.get('invoiceFileName'),
            invoice_mime_type=data.get('invoiceMimeType'),
            invoice_bucket_path=data.get('invoiceBucketPath'),
            invoice_size_bytes=data.get('invoiceSizeBytes'),
            invoice_uploaded_at=datetime.fromisoformat(data.get('invoiceUploadedAt')) if data.get('invoiceUploadedAt') is not None else None,
            has_invoice=data.get('hasInvoice'),
            created_by_user_id=data.get('createdByUserId'),
            created_at=datetime.fromisoformat(data.get('createdAt')) if data.get('createdAt') is not None else None,
            captured_at=datetime.fromisoformat(data.get('capturedAt')) if data.get('capturedAt') is not None else None,
            additional_data=data.get('additionalData')
        )
        if data.get('id') is not None:
            instance._restore_id_id(data.get('id'))
        return instance
