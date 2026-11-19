* Post-exit IPO_GET_REQUEST_PROPERTIES on CL_RSO_RES_RESOURCE=>GET_REQUEST_PROPERTIES
* Enhancement implementation, for example Z_RSO_RES_HDR_CASE (SE24 > Class > Enhance).
*
* Required on classic SAP BW (7.x, also embedded in S/4HANA such as SAP_BW 758).
* The REST framework looks the Accept header up case-sensitively while the kernel delivers header names in lower case, so content
* negotiation falls back to resource version 1.0.0 and answers HTTP 406. This adds a
* canonically spelled duplicate of the three headers concerned and changes nothing else.
*
* Paste the body below into the generated post-method; SE24 writes METHOD/ENDMETHOD itself.
* It cannot be created over ADT: class pre/post exits exist in the SAP GUI only.

  DATA lt_add TYPE tihttpnvp.

  LOOP AT e_t_header_fields REFERENCE INTO DATA(lr_f).
    CASE to_lower( lr_f->name ).
      WHEN 'accept'.
        IF lr_f->name <> 'Accept'.
          APPEND VALUE ihttpnvp( name = 'Accept' value = lr_f->value ) TO lt_add.
        ENDIF.
      WHEN 'content-type'.
        IF lr_f->name <> 'Content-Type'.
          APPEND VALUE ihttpnvp( name = 'Content-Type' value = lr_f->value ) TO lt_add.
        ENDIF.
      WHEN 'if-modified-since'.
        IF lr_f->name <> 'If-Modified-Since'.
          APPEND VALUE ihttpnvp( name = 'If-Modified-Since' value = lr_f->value ) TO lt_add.
        ENDIF.
    ENDCASE.
  ENDLOOP.

  APPEND LINES OF lt_add TO e_t_header_fields.
