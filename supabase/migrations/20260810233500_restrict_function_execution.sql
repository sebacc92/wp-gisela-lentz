-- PostgreSQL grants EXECUTE on new functions to PUBLIC by default. Remove that
-- inherited access; the explicit authenticated/service_role grants from the
-- previous migration remain in force for the RPCs used by the application.
revoke execute on all functions in schema public from public, anon;
