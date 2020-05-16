
export const enum WebErrorCode {
    // values below 100 are from website
    API_ERR_INVALID_EMAIL = 1,
    API_ERR_NO_INSTANCE = 2,
    API_ERR_INTERNAL = 3,
    API_USER_DOESNT_EXIST = 4,
    NO_BOT_SUBSCRIPTIONS_FOUND = 5,

    TRADEBOOK_NOT_AVAILABLE = 100,
    TRADEBOOK_ERROR_QUERY = 101,
    TRADEBOOK_ERROR_PARAMS = 102
}