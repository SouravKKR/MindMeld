from enum import IntEnum

class PaymentProviders(IntEnum):
    RAZORPAY = 0
    STRIPE = 1
    PAYPAL = 2
    ORG_AUTO_ASSIGN = 3
    ZOHO = 4
