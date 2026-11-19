"! Creates and activates the ICF service /sap/bc/zbwmcp with handler ZCL_BWMCP_HTTP.
"! Run once by bw-api-patch/install.mjs through the ADT classrun service, then deleted.
"! Idempotent: an existing node is only activated. The node is created without logon data,
"! so the service runs as the calling user and BW authorisations apply unchanged.
"! The installer replaces the package below before uploading the class.
CLASS zcl_bwmcp_install DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    INTERFACES if_oo_adt_classrun.
    CONSTANTS c_package TYPE devclass VALUE '$TMP'.
ENDCLASS.

CLASS zcl_bwmcp_install IMPLEMENTATION.
  METHOD if_oo_adt_classrun~main.
    DATA hostnumber TYPE icfhostnum.
    DATA parent_guid TYPE icfnodguid.
    DATA node_guid TYPE icfnodguid.
    DATA node_name TYPE icfname.
    DATA suffix TYPE icfredurl.
    DATA handlers TYPE icfhndlist.
    DATA description TYPE icfdocu.
    DATA service_desc TYPE icfserdesc.

    SELECT SINGLE hostnumber FROM icfvirhost INTO hostnumber
      WHERE icf_name = 'DEFAULT_HOST' AND protocol = 'HTTP'.
    IF sy-subrc <> 0.
      out->write( 'ERROR: DEFAULT_HOST HTTP host not found' ).
      RETURN.
    ENDIF.
    cl_icf_tree=>if_icf_tree~service_from_url(
      EXPORTING url = '/sap/bc/' hostnumber = hostnumber
      IMPORTING icfnodguid = parent_guid icf_name = node_name urlsuffix = suffix
      EXCEPTIONS OTHERS = 1 ).
    IF sy-subrc <> 0 OR parent_guid IS INITIAL OR node_name <> 'BC' OR suffix IS NOT INITIAL.
      out->write( |ERROR: parent lookup failed: { sy-subrc } { node_name } { suffix }| ).
      RETURN.
    ENDIF.

    SELECT SINGLE icfnodguid FROM icfservice INTO node_guid
      WHERE icfparguid = parent_guid AND icf_name = 'ZBWMCP'.
    IF sy-subrc = 0.
      out->write( |ZBWMCP exists: { node_guid }| ).
    ELSE.
      APPEND 'ZCL_BWMCP_HTTP' TO handlers.
      description-icf_docu = 'BW MCP read-only DTP metadata helper'.
      cl_icf_tree=>if_icf_tree~insert_node(
        EXPORTING icf_name = 'zbwmcp' icfparguid = parent_guid
          icfdocu = description doculang = 'E' icfhandlst = handlers
          icfserdesc = service_desc package = c_package application = space
          i_dark_transport = abap_true
        IMPORTING icfnodguid = node_guid
        EXCEPTIONS OTHERS = 1 ).
      IF sy-subrc <> 0 OR node_guid IS INITIAL.
        out->write( |ERROR: insertion failed: { sy-subrc } { sy-msgid } { sy-msgno } { sy-msgv1 } { sy-msgv2 }| ).
        RETURN.
      ENDIF.
      out->write( |Created /sap/bc/zbwmcp in { c_package }: { node_guid }| ).
    ENDIF.

    cl_icf_tree=>activate_node(
      EXPORTING nodeguid = node_guid expand = space
      EXCEPTIONS OTHERS = 1 ).
    IF sy-subrc <> 0.
      out->write( |ERROR: activation failed: { sy-subrc } { sy-msgid } { sy-msgno }| ).
      RETURN.
    ENDIF.
    COMMIT WORK AND WAIT.
    out->write( 'SUCCESS: /sap/bc/zbwmcp activated with ZCL_BWMCP_HTTP' ).
  ENDMETHOD.
ENDCLASS.
